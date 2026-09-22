import { createHash, randomUUID, type Hash } from "node:crypto";
import { appendFile, mkdir, rename, readFile, rm } from "node:fs/promises";
import * as fsSync from "node:fs";
import { dirname, join } from "node:path";

export interface AuditEntry {
  sequence: number;
  timestamp: string;
  requestId: string;
  transactionId?: string;
  tool: string;
  target?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  beforeHash?: string;
  afterHash?: string;
  verified?: boolean;
  [extra: string]: unknown;
}

interface ChainState {
  sequence: number;
  previousEntryHash: string;
}

interface RecoveredChain {
  chain: ChainState;
  currentFileBytes: number;
  currentFileHash: Hash;
}

interface VerifiedSegment {
  chain: ChainState;
  fileSha256: string;
  bytes: number;
  firstRecord?: Record<string, unknown>;
}

const GENESIS_HASH = "sha256:genesis";
const MAX_REDACT_DEPTH = 6;
const SENSITIVE_KEYS = /(password|passphrase|secret|authorization|api[-_]?key|credential|token|cookie|session|private[-_]?key|idempotency[-_]?key)/i;

export function sha256Of(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) out[key] = "[redacted]";
    else out[key] = redact(val, depth + 1);
  }
  return out;
}

export interface AuditLogOptions {
  path?: string;
  enabled?: boolean;
  maxFileBytes?: number;
  maxRotatedFiles?: number;
}

function verifyLine(
  parsed: Record<string, unknown>,
  expectedPrevious: string | undefined
): { ok: boolean; sequence: number; entryHash: string; previousEntryHash: string } {
  const entryHash = typeof parsed.entryHash === "string" ? parsed.entryHash : "";
  const previousEntryHash = typeof parsed.previousEntryHash === "string" ? parsed.previousEntryHash : "";
  const sequence = typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence) ? parsed.sequence : -1;
  if (!entryHash || !previousEntryHash || sequence < 0) {
    return { ok: false, sequence, entryHash, previousEntryHash };
  }
  if (expectedPrevious !== undefined && previousEntryHash !== expectedPrevious) {
    return { ok: false, sequence, entryHash, previousEntryHash };
  }
  const rest = { ...parsed };
  delete rest.entryHash;
  delete rest.previousEntryHash;
  const recomputed = sha256Of({ entry: stableStringify(rest), previous: previousEntryHash });
  return { ok: recomputed === entryHash, sequence, entryHash, previousEntryHash };
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function verifySegmentText(
  text: string,
  expectedPrevious: string | undefined,
  expectedSequence: number | undefined
): VerifiedSegment {
  let previous = expectedPrevious;
  let sequence = expectedSequence;
  let state: ChainState | undefined;
  let firstRecord: Record<string, unknown> | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error("AUDIT_CHAIN_CORRUPT: audit segment contains invalid JSON");
    }
    firstRecord ??= parsed;
    const verified = verifyLine(parsed, previous);
    if (!verified.ok) {
      throw new Error("AUDIT_CHAIN_CORRUPT: retained audit segment failed hash verification");
    }
    if (sequence !== undefined && verified.sequence !== sequence + 1) {
      throw new Error("AUDIT_CHAIN_CORRUPT: audit sequence is not contiguous");
    }
    previous = verified.entryHash;
    sequence = verified.sequence;
    state = { sequence: verified.sequence, previousEntryHash: verified.entryHash };
  }

  return {
    chain: state ?? {
      sequence: expectedSequence ?? 0,
      previousEntryHash: expectedPrevious ?? GENESIS_HASH
    },
    fileSha256: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    bytes: Buffer.byteLength(text, "utf8"),
    ...(firstRecord ? { firstRecord } : {})
  };
}

function rotationPreviousFileSha(firstRecord: Record<string, unknown> | undefined): string | undefined {
  if (!firstRecord || firstRecord.tool !== "audit_rotation") return undefined;
  const policy = firstRecord.policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const hash = (policy as Record<string, unknown>).previousFileSha256;
  return typeof hash === "string" ? hash : undefined;
}

function recoverChain(path: string, maxRotatedFiles: number): RecoveredChain {
  const activeExists = fsSync.existsSync(path);
  const rotatedIndices: number[] = [];
  for (let index = 1; index <= maxRotatedFiles; index++) {
    if (fsSync.existsSync(`${path}.${index}`)) rotatedIndices.push(index);
  }

  if (!activeExists && rotatedIndices.length === 0) {
    return {
      chain: { sequence: 0, previousEntryHash: GENESIS_HASH },
      currentFileBytes: 0,
      currentFileHash: createHash("sha256")
    };
  }

  if (rotatedIndices.length > 0) {
    const highest = Math.max(...rotatedIndices);
    for (let index = 1; index <= highest; index++) {
      if (!rotatedIndices.includes(index)) {
        throw new Error("AUDIT_CHAIN_CORRUPT: retained audit rotation contains a missing segment");
      }
    }
    if (!activeExists) {
      throw new Error("AUDIT_CHAIN_CORRUPT: active audit segment is missing while rotated segments remain");
    }
  }

  const segmentPaths = [
    ...rotatedIndices.sort((a, b) => b - a).map(index => `${path}.${index}`),
    ...(activeExists ? [path] : [])
  ];

  let previousState: ChainState | undefined;
  let previousFileSha256: string | undefined;
  let activeText = "";

  for (let index = 0; index < segmentPaths.length; index++) {
    const segmentPath = segmentPaths[index]!;
    const text = fsSync.readFileSync(segmentPath, "utf8");
    if (segmentPath === path) activeText = text;

    const isOldestRetained = index === 0 && rotatedIndices.length > 0;
    const expectedPrevious = isOldestRetained
      ? undefined
      : previousState?.previousEntryHash ?? GENESIS_HASH;
    const expectedSequence = isOldestRetained ? undefined : previousState?.sequence ?? 0;
    const verified = verifySegmentText(text, expectedPrevious, expectedSequence);

    if (index > 0) {
      const declaredPreviousFileSha = rotationPreviousFileSha(verified.firstRecord);
      if (!declaredPreviousFileSha || declaredPreviousFileSha !== previousFileSha256) {
        throw new Error("AUDIT_CHAIN_CORRUPT: rotation file hash anchor does not match retained predecessor");
      }
    } else if (rotatedIndices.length === 0 && verified.firstRecord) {
      const firstPrevious = verified.firstRecord.previousEntryHash;
      if (firstPrevious !== GENESIS_HASH) {
        throw new Error("AUDIT_CHAIN_CORRUPT: active audit chain does not begin at genesis");
      }
    }

    previousState = verified.chain;
    previousFileSha256 = verified.fileSha256;
  }

  const currentFileHash = createHash("sha256");
  currentFileHash.update(activeText, "utf8");
  return {
    chain: previousState ?? { sequence: 0, previousEntryHash: GENESIS_HASH },
    currentFileBytes: Buffer.byteLength(activeText, "utf8"),
    currentFileHash
  };
}

export class AuditLog {
  private chain: ChainState = { sequence: 0, previousEntryHash: GENESIS_HASH };
  private readonly enabled: boolean;
  private readonly path: string | undefined;
  private readonly maxFileBytes: number;
  private readonly maxRotatedFiles: number;
  private startupError: string | undefined;
  private currentFileBytes = 0;
  private currentFileHash: Hash = createHash("sha256");

  constructor(options: AuditLogOptions = {}) {
    this.enabled = options.enabled ?? process.env.MASTERCAM_MCP_AUDIT !== "0";
    this.path = options.path
      ?? process.env.MASTERCAM_MCP_AUDIT_PATH
      ?? join(process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? process.env.TMPDIR ?? ".", "mastercam-mcp", "audit.jsonl");
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxRotatedFiles = options.maxRotatedFiles ?? 5;

    if (this.enabled && this.path) {
      try {
        const recovered = recoverChain(this.path, this.maxRotatedFiles);
        this.chain = recovered.chain;
        this.currentFileBytes = recovered.currentFileBytes;
        this.currentFileHash = recovered.currentFileHash;
      } catch (error) {
        this.startupError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  get isEnabled(): boolean { return this.enabled; }
  get location(): string { return this.path ?? "(memory)"; }
  get integrityError(): string | undefined { return this.startupError; }

  record(entry: Omit<AuditEntry, "sequence" | "timestamp">): AuditEntry {
    if (this.startupError) {
      throw new Error(this.startupError);
    }
    const record: AuditEntry = redact({ ...entry }) as AuditEntry;
    const full: AuditEntry = {
      ...record,
      sequence: this.chain.sequence + 1,
      timestamp: new Date().toISOString()
    };
    const previousHash = this.chain.previousEntryHash;
    const entryHash = sha256Of({ entry: stableStringify(full), previous: previousHash });
    this.chain = { sequence: full.sequence, previousEntryHash: entryHash };
    if (this.enabled && this.path) {
      const line = `${JSON.stringify({ ...full, previousEntryHash: previousHash, entryHash })}\n`;
      this.write(line);
    }
    return full;
  }

  /**
   * Records a safety-critical event and does not resolve until its audit append
   * (and any required rotation) is durable from the process perspective.
   */
  async recordCritical(entry: Omit<AuditEntry, "sequence" | "timestamp">): Promise<AuditEntry> {
    const full = this.record(entry);
    await this.flush();
    return full;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.startupError) throw new Error(this.startupError);
  }

  private writeBuffer = "";
  private tail: Promise<void> = Promise.resolve();

  private write(line: string): void {
    this.writeBuffer += line;
    this.tail = this.tail.then(async () => {
      const payload = this.writeBuffer;
      this.writeBuffer = "";
      if (!payload) return;
      await mkdir(dirname(this.path!), { recursive: true });
      await appendFile(this.path!, payload, "utf8");
      this.currentFileBytes += Buffer.byteLength(payload, "utf8");
      this.currentFileHash.update(payload, "utf8");
      await this.rotateIfNeeded();
    }).catch(error => {
      this.startupError = `AUDIT_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  private async rotateIfNeeded(): Promise<void> {
    if (this.currentFileBytes < this.maxFileBytes) return;

    const path = this.path!;
    const previousFileSha256 = `sha256:${this.currentFileHash.digest("hex")}`;

    await rm(`${path}.${this.maxRotatedFiles}`, { force: true });
    for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      try {
        await rename(from, to);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
    await rename(path, `${path}.1`);

    const previousHash = this.chain.previousEntryHash;
    const rotationBody = {
      sequence: this.chain.sequence + 1,
      timestamp: new Date().toISOString(),
      requestId: "audit-rotation",
      tool: "audit_rotation",
      target: { previousFile: `${path}.1` },
      policy: { previousFileSha256 }
    };
    const entryHash = sha256Of({ entry: stableStringify(rotationBody), previous: previousHash });
    this.chain = { sequence: rotationBody.sequence, previousEntryHash: entryHash };
    const rotationLine = `${JSON.stringify({ ...rotationBody, previousEntryHash: previousHash, entryHash })}\n`;
    await appendFile(path, rotationLine, "utf8");
    this.currentFileBytes = Buffer.byteLength(rotationLine, "utf8");
    this.currentFileHash = createHash("sha256");
    this.currentFileHash.update(rotationLine, "utf8");
  }
}

export async function verifyAuditChain(path: string): Promise<{ ok: boolean; entries: number; brokenAt?: number; anchor?: string; finalHash?: string }> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return { ok: true, entries: 0 }; }

  let expectedPrevious: string | undefined;
  let expectedSequence: number | undefined;
  let anchor: string | undefined;
  let finalHash: string | undefined;
  let count = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    count++;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; }
    catch { return { ok: false, entries: count, brokenAt: count, anchor, finalHash }; }

    const verified = verifyLine(parsed, expectedPrevious);
    if (!verified.ok) return { ok: false, entries: count, brokenAt: count, anchor, finalHash };
    if (expectedSequence !== undefined && verified.sequence !== expectedSequence + 1) {
      return { ok: false, entries: count, brokenAt: count, anchor, finalHash };
    }
    if (anchor === undefined) anchor = verified.previousEntryHash;
    expectedPrevious = verified.entryHash;
    expectedSequence = verified.sequence;
    finalHash = verified.entryHash;
  }

  return { ok: true, entries: count, anchor, finalHash };
}

export function newTransactionId(): string {
  return `txn_${randomUUID().replaceAll("-", "")}`;
}

export function newApprovalToken(): string {
  return `appr_${randomUUID().replaceAll("-", "")}`;
}
