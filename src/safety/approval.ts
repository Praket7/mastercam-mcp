import { createHash, randomBytes } from "node:crypto";
import { sha256Of } from "../audit/audit-log.js";

export interface IdempotencyRecord {
  key: string;
  tool: string;
  targetHash: string;
  argumentHash: string;
  result: any;
}

export interface QuantitySnapshot { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } }

export interface PreviewRecord {
  approvalToken: string;
  tool: string;
  operationId: number;
  changes: QuantitySnapshot;
  before: QuantitySnapshot;
  after: QuantitySnapshot;
  documentRevision: string;
  operationFingerprint: string;
  beforeHash: string;
  afterHash: string;
  requiresRegeneration: boolean;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface ApplyRecord extends PreviewRecord {
  appliedAt: number;
  transactionId: string;
}

export interface RollbackRecord {
  transactionId: string;
  rollbackOf: string;
  operationId: number;
  restored: QuantitySnapshot;
  /** State the transaction produced; rollback refuses if current state diverges. */
  restoredSource?: QuantitySnapshot;
  appliedAt: number;
  expiresAt: number;
  used: boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_LEDGER = 500;

/**
 * The ledger is the single source of truth for approvals and rollbacks.
 * A model cannot invent `confirmed: true`; it must present a server-issued,
 * single-use, expiring token bound to the exact state it previewed.
 */
export class ApprovalLedger {
  private previews = new Map<string, PreviewRecord>();
  private applied = new Map<string, ApplyRecord>();
  private rollbacks = new Map<string, RollbackRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  createPreview(input: Omit<PreviewRecord, "approvalToken" | "createdAt" | "expiresAt" | "used">): PreviewRecord {
    this.evict();
    const token = `appr_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const record: PreviewRecord = {
      ...input,
      approvalToken: token,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      used: false
    };
    this.previews.set(token, record);
    return record;
  }

  /** Non-consuming lookup so the apply path can resolve the target for CAS. */
  peekPreview(token: string): PreviewRecord {
    const record = this.previews.get(token);
    if (!record) throw new Error("APPROVAL_TOKEN_INVALID: unknown or already consumed approval token");
    return record;
  }

  /** Returns the record and marks it used; throws ErrorInfo on any invalid state. */
  consumePreview(token: string, expected: { operationFingerprint: string; documentRevision: string }): PreviewRecord {
    const record = this.previews.get(token);
    if (!record) throw new Error("APPROVAL_TOKEN_INVALID: unknown or already consumed approval token");
    this.previews.delete(token);
    if (record.used) throw new Error("APPROVAL_TOKEN_INVALID: approval token was already used");
    if (Date.now() > record.expiresAt) throw new Error("APPROVAL_TOKEN_EXPIRED: request a fresh preview");
    if (record.operationFingerprint !== expected.operationFingerprint) {
      throw new Error(`STALE_PREVIEW: operation changed since preview (${record.operationFingerprint} != ${expected.operationFingerprint})`);
    }
    if (record.documentRevision !== expected.documentRevision) {
      throw new Error(`STALE_PREVIEW: document changed since preview (${record.documentRevision} != ${expected.documentRevision})`);
    }
    record.used = true;
    return record;
  }

  recordApply(record: PreviewRecord): ApplyRecord {
    const applied: ApplyRecord = {
      ...record,
      appliedAt: Date.now(),
      transactionId: `txn_${randomBytes(16).toString("base64url")}`
    };
    this.applied.set(applied.transactionId, applied);
    return applied;
  }

  /** Creates a one-use rollback receipt bound to the applied transaction. */
  createRollback(transactionId: string): RollbackRecord {
    const applied = this.applied.get(transactionId);
    if (!applied) throw new Error("APPROVAL_TOKEN_INVALID: unknown transaction");
    const record: RollbackRecord = {
      transactionId: `txn_${randomBytes(16).toString("base64url")}`,
      rollbackOf: transactionId,
      operationId: applied.operationId,
      restored: applied.before,
      restoredSource: applied.after,
      appliedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      used: false
    };
    this.rollbacks.set(record.transactionId, record);
    return record;
  }

  peekRollback(transactionId: string): RollbackRecord {
    const record = this.rollbacks.get(transactionId) ?? [...this.rollbacks.values()].find(r => r.rollbackOf === transactionId && !r.used);
    if (!record) throw new Error("APPROVAL_TOKEN_INVALID: unknown or already consumed rollback transaction");
    if (record.used) throw new Error("APPROVAL_TOKEN_INVALID: rollback was already applied");
    if (Date.now() > record.expiresAt) throw new Error("APPROVAL_TOKEN_EXPIRED: request a new rollback receipt");
    return record;
  }

  consumeRollback(transactionId: string): RollbackRecord {
    const record = this.peekRollback(transactionId);
    record.used = true;
    return record;
  }

  /** Idempotency: repeat calls with the same key return the original outcome only if identity matches. */
  idempotencyKeySeen(key: string, tool: string, targetHash: string, argumentHash: string): any | undefined {
    const record = this.idempotency.get(key);
    if (!record) return undefined;
    if (record.tool !== tool || record.targetHash !== targetHash || record.argumentHash !== argumentHash) {
      throw new Error("IDEMPOTENCY_CONFLICT: same key used for different operation or arguments");
    }
    return record.result;
  }

  rememberIdempotency(key: string, tool: string, targetHash: string, argumentHash: string, result: any): void {
    if (this.idempotency.size >= MAX_LEDGER) {
      const first = this.idempotency.keys().next().value;
      if (first) this.idempotency.delete(first);
    }
    this.idempotency.set(key, { key, tool, targetHash, argumentHash, result });
  }

  private idempotency = new Map<string, IdempotencyRecord>();

  private evict(): void {
    if (this.previews.size < MAX_LEDGER) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, record] of this.previews) if (record.used || record.expiresAt < cutoff) this.previews.delete(token);
    while (this.previews.size >= MAX_LEDGER) {
      const oldest = this.previews.keys().next().value;
      if (!oldest) break;
      this.previews.delete(oldest);
    }
  }
}

export function fingerprintOperation(operationId: number, state: unknown): string {
  return sha256Of({ operationId, state });
}

export function documentRevision(seed: unknown): string {
  return `rev_${createHash("sha256").update(sha256Of(seed)).digest("hex").slice(0, 16)}`;
}
export const ApprovalManager = ApprovalLedger;
