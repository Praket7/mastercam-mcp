import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AuditEntry {
  sequence: number;
  timestamp: string;
  requestId: string;
  transactionId?: string;
  tool: string;
  target: Record<string, unknown>;
  policy: Record<string, unknown>;
  beforeHash?: string;
  afterHash?: string;
  verified: boolean;
  previousEntryHash?: string;
  entryHash: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private sequence = 0;
  private readonly path: string;
  private readonly maxEntries: number;
  private genesisHash = "0".repeat(64);

  constructor(path: string, maxEntries = 500) {
    this.path = path;
    this.maxEntries = maxEntries;
    this.load();
  }

  private load() {
    const fs = require("node:fs");
    if (fs.existsSync(this.path)) {
      try {
        const content = fs.readFileSync(this.path, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines.slice(-this.maxEntries)) {
          const entry = JSON.parse(line) as AuditEntry;
          this.entries.push(entry);
          this.sequence = Math.max(this.sequence, entry.sequence);
        }
      } catch { this.entries = []; }
    }
  }

  append(entry: Omit<AuditEntry, "sequence" | "timestamp" | "previousEntryHash" | "entryHash">): AuditEntry {
    this.sequence++;
    const timestamp = new Date().toISOString();
    const previousEntryHash = this.entries.length > 0 
      ? (this.entries[this.entries.length - 1]?.entryHash ?? this.genesisHash)
      : this.genesisHash;
    const hashInput = { ...entry, sequence: this.sequence, timestamp, previousEntryHash };
    const entryHash = this.computeEntryHash(hashInput);
    const fullEntry: AuditEntry = { ...hashInput, entryHash };
    this.entries.push(fullEntry);
    this.persist(fullEntry);
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries);
    return fullEntry;
  }

  private persist(entry: AuditEntry) {
    try { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(this.redact(entry)) + "\n"); } catch { }
  }

  private computeEntryHash(entry: Omit<AuditEntry, "entryHash">): string {
    return createHash("sha256").update(JSON.stringify(entry, Object.keys(entry).sort())).digest("hex");
  }

  private redact(entry: AuditEntry): AuditEntry {
    const redacted = { ...entry };
    redacted.target = this.redactObject(redacted.target);
    redacted.policy = this.redactObject(redacted.policy);
    return redacted;
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (this.isSensitiveKey(key)) {
        result[key] = "[REDACTED]";
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.redactObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map(v => 
          v && typeof v === "object" ? this.redactObject(v as Record<string, unknown>) : v
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      /^password$/i,
      /^secret$/i,
      /^token$/i,
      /^authorization$/i,
      /^apikey$/i,
      /^api_key$/i,
      /^credential$/i,
      /^token$/i,
      /approvalToken/i,
      /rollbackToken/i,
      /accessToken/i,
      /refreshToken/i,
      /idempotencyKey/i,
    ];
    return sensitivePatterns.some(pattern => pattern.test(key));
  }

  query(options: { limit?: number; tool?: string; operationId?: number } = {}): { entries: AuditEntry[]; total: number } {
    let result = this.entries;
    if (options.tool) result = result.filter(e => e.tool === options.tool);
    if (options.operationId) result = result.filter(e => e.target["operationId"] === options.operationId);
    const limit = Math.min(options.limit ?? 100, 1000);
    return { entries: result.slice(-limit), total: result.length };
  }

  verifyChain(): { valid: boolean; brokenAt?: number } {
    let previousHash = "0".repeat(64);
    for (const entry of this.entries) {
      if (entry.previousEntryHash !== previousHash) return { valid: false, brokenAt: entry.sequence };
      const { entryHash: _, ...rest } = entry;
      const computed = this.computeEntryHash(rest);
      if (computed !== entry.entryHash) return { valid: false, brokenAt: entry.sequence };
      previousHash = entry.entryHash;
    }
    return { valid: true };
  }
}

function getDefaultAuditPath(): string {
  const envPath = process.env["MASTERCAM_MCP_AUDIT_PATH"];
  if (envPath) return envPath;
  return dirname(fileURLToPath(import.meta.url)) + "/../mastercam-mcp/audit.jsonl";
}

export const auditLog = new AuditLog(getDefaultAuditPath());