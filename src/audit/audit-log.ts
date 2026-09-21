import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, stat, rename, readFile } from "node:fs/promises";
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

const GENESIS_HASH = "sha256:genesis";
const MAX_REDACT_DEPTH = 6;
const SENSITIVE_KEYS = /(password|secret|authorization|apikey|api_key|credential|approvalToken|rollbackToken|accessToken|refreshToken|idempotencyKey)/i;

export function sha256Of(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

/** Deterministic serialization so hashes do not depend on key insertion order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH || value === null || typeof value !== "object") return value;
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

export class AuditLog {
  private chain: ChainState = { sequence: 0, previousEntryHash: GENESIS_HASH };
  private readonly enabled: boolean;
  private readonly path: string | undefined;
  private readonly maxFileBytes: number;
  private readonly maxRotatedFiles: number;

  constructor(options: AuditLogOptions = {}) {
    this.enabled = options.enabled ?? process.env.MASTERCAM_MCP_AUDIT !== "0";
    this.path = options.path
      ?? process.env.MASTERCAM_MCP_AUDIT_PATH
      ?? join(process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? process.env.TMPDIR ?? ".", "mastercam-mcp", "audit.jsonl");
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxRotatedFiles = options.maxRotatedFiles ?? 5;
    // Recover chain tail from existing log so restart does not break hash chain
    if (this.enabled && this.path) {
      try {
        // Use sync read during construction to avoid race with first record()
        if (fsSync.existsSync(this.path)) {
          const text = fsSync.readFileSync(this.path, "utf8");
          let lastHash = GENESIS_HASH;
          let lastSeq = 0;
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as { sequence?: number; entryHash?: string };
              if (typeof parsed.entryHash === "string" && parsed.entryHash) lastHash = parsed.entryHash;
              if (typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence)) lastSeq = parsed.sequence;
            } catch { /* ignore corrupt line, keep last good */ }
          }
          this.chain = { sequence: lastSeq, previousEntryHash: lastHash };
        }
      } catch { /* recovery is best-effort; start from genesis if it fails */ }
    }
  }

  get isEnabled(): boolean { return this.enabled; }
  get location(): string { return this.path ?? "(memory)"; }

  /** Records an entry asynchronously; callers never await disk on the request path. */
  record(entry: Omit<AuditEntry, "sequence" | "timestamp">): AuditEntry {
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

  /** Drain for tests and graceful shutdown. */
  async flush(): Promise<void> {
    await this.tail;
  }

  private writeBuffer = "";
  private writesInFlight = 0;
  private tail: Promise<void> = Promise.resolve();

  private write(line: string): void {
    this.writeBuffer += line;
    this.tail = this.tail.then(async () => {
      const payload = this.writeBuffer;
      this.writeBuffer = "";
      if (!payload) return;
      this.writesInFlight++;
      try {
        await mkdir(dirname(this.path!), { recursive: true });
        await appendFile(this.path!, payload, "utf8");
        await this.rotateIfNeeded();
      } catch {
        // Audit failures must never break the machining request (audit §30).
      } finally {
        this.writesInFlight--;
      }
    });
  }

  private async rotateIfNeeded(): Promise<void> {
    const path = this.path!;
    try {
      const info = await stat(path);
      if (info.size < this.maxFileBytes) return;
      for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
        const from = `${path}.${i}`;
        const to = `${path}.${i + 1}`;
        try { await rename(from, to); } catch { /* absent file */ }
      }
      await rename(path, `${path}.1`);
    } catch { /* stat failure means nothing to rotate */ }
  }
}

function replacer(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
void replacer;

/** Verifies a log file's hash chain; used by tests and the doctor command. */
export async function verifyAuditChain(path: string): Promise<{ ok: boolean; entries: number; brokenAt?: number }> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return { ok: true, entries: 0 }; }
  let previous = GENESIS_HASH;
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    count++;
    let parsed: { entryHash?: string; previousEntryHash?: string; [k: string]: unknown };
    try { parsed = JSON.parse(line); } catch { return { ok: false, entries: count, brokenAt: count }; }
    if (parsed.previousEntryHash !== previous) return { ok: false, entries: count, brokenAt: count };
    const rest = { ...parsed } as Record<string, unknown>;
    delete rest.entryHash;
    delete rest.previousEntryHash;
    const recomputed = sha256Of({ entry: stableStringify(rest), previous });
    if (recomputed !== parsed.entryHash) return { ok: false, entries: count, brokenAt: count };
    previous = String(parsed.entryHash);
  }
  return { ok: true, entries: count };
}

export function newTransactionId(): string {
  return `txn_${randomUUID().replaceAll("-", "")}`;
}

export function newApprovalToken(): string {
  return `appr_${randomUUID().replaceAll("-", "")}`;
}
