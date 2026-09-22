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

const GENESIS_HASH = "sha256:genesis";
const MAX_REDACT_DEPTH = 6;
const SENSITIVE_KEYS = /(password|passwd|secret|authorization|api[-_]?key|credential|approval[-_]?token|rollback[-_]?token|access[-_]?token|refresh[-_]?token|idempotency[-_]?key|cookie|session[-_]?id|private[-_]?key|client[-_]?secret)/i;

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
  if (depth > MAX_REDACT_DEPTH) return "[truncated]";
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

function recoverChain(path: string): RecoveredChain {
  let text: string;
  try {
    text = fsSync.readFileSync(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return {
        chain: { sequence: 0, previousEntryHash: GENESIS_HASH },
        currentFileBytes: 0,
        currentFileHash: createHash("sha256")
      };
    }
    throw error;
  }

  let expectedPrevious: string | undefined;
  let state: ChainState | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const verified = verifyLine(parsed, expectedPrevious);
    if (!verified.ok) throw new Error("AUDIT_CHAIN_CORRUPT: existing audit log failed verification");
    expectedPrevious = verified.entryHash;
    state = { sequence: verified.sequence, previousEntryHash: verified.entryHash };
  }

  const currentFileHash = createHash("sha256");
  currentFileHash.update(text, "utf8");
  return {
    chain: state ?? { sequence: 0, previousEntryHash: GENESIS_HASH },
    currentFileBytes: Buffer.byteLength(text, "utf8"),
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
        const recovered = recoverChain(this.path);
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
      void this.write(line);
    }
    return full;
  }

  /**
   * Record safety-critical evidence and wait until it is durably appended.
   * Mutation paths should use this method before returning success.
   */
  async recordCritical(entry: Omit<AuditEntry, "sequence" | "timestamp">): Promise<AuditEntry> {
    const full = this.record(entry);
    await this.flush();
    if (this.startupError) throw new Error(this.startupError);
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

    // Remove the oldest retained segment first so rename behavior is identical
    // on Windows and POSIX, including maxRotatedFiles === 1.
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
    if (anchor === undefined) anchor = verified.previousEntryHash;
    expectedPrevious = verified.entryHash;
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
