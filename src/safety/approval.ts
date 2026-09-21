import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export interface ApprovalRecord {
  approvalToken: string;
  transactionId: string;
  operationId: number;
  operationFingerprint: string;
  documentRevision: string;
  beforeHash: string;
  proposedHash: string;
  proposed: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } };
  expiresAt: string;
  used: boolean;
}

export interface TransactionReceipt {
  transactionId: string;
  partFingerprint: string;
  operationId: number;
  beforeHash: string;
  afterHash: string;
  before: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } };
  after: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } };
  createdAt: string;
  expiresAt: string;
}

const APPROVAL_TTL_MS = 5 * 60 * 1000;
const TX_TTL_MS = 10 * 60 * 1000;

export class ApprovalManager {
  private approvals = new Map<string, ApprovalRecord>();
  private transactions = new Map<string, TransactionReceipt>();

  createApproval(operationId: number, operationFingerprint: string, documentRevision: string, before: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } }, proposed: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } }): ApprovalRecord {
    const approvalToken = randomUUID();
    const transactionId = randomUUID();
    const beforeHash = hashObject(before);
    const proposedHash = hashObject(proposed);
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();

    const approval: ApprovalRecord = { approvalToken, transactionId, operationId, operationFingerprint, documentRevision, beforeHash, proposedHash, proposed, expiresAt, used: false };
    this.approvals.set(approvalToken, approval);
    return approval;
  }

  validateApproval(approvalToken: string, currentOperationFingerprint: string, currentDocumentRevision: string): { approval: ApprovalRecord; error?: string } {
    const approval = this.approvals.get(approvalToken);
    if (!approval) return { approval: null as any, error: "INVALID_APPROVAL_TOKEN" };
    if (approval.used) return { approval: null as any, error: "APPROVAL_TOKEN_USED" };
    if (approval.expiresAt < new Date().toISOString()) { this.approvals.delete(approvalToken); return { approval: null as any, error: "APPROVAL_TOKEN_EXPIRED" }; }
    if (currentOperationFingerprint !== approval.operationFingerprint) return { approval: null as any, error: "STALE_PREVIEW" };
    if (currentDocumentRevision !== approval.documentRevision) return { approval: null as any, error: "STALE_PREVIEW" };
    return { approval };
  }

  markUsed(approvalToken: string): void {
    const approval = this.approvals.get(approvalToken);
    if (approval) { approval.used = true; }
  }

  createTransactionReceipt(approval: ApprovalRecord, after: { feedRate?: { value: number; unit: string }; spindleSpeed?: { value: number; unit: string } }, partFingerprint: string): TransactionReceipt {
    const afterHash = hashObject(after);
    const receipt: TransactionReceipt = {
      transactionId: approval.transactionId,
      partFingerprint,
      operationId: approval.operationId,
      beforeHash: approval.beforeHash,
      afterHash,
      before: approval.proposed,
      after,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TX_TTL_MS).toISOString()
    };
    this.transactions.set(approval.transactionId, receipt);
    return receipt;
  }

  getTransaction(transactionId: string): TransactionReceipt | undefined {
    const tx = this.transactions.get(transactionId);
    if (tx && tx.expiresAt < new Date().toISOString()) { this.transactions.delete(transactionId); return undefined; }
    return tx;
  }

  cleanup(): void {
    const now = new Date().toISOString();
    for (const [token, approval] of this.approvals) { if (approval.expiresAt < now) this.approvals.delete(token); }
    for (const [txId, tx] of this.transactions) { if (tx.expiresAt < now) this.transactions.delete(txId); }
  }
}

function hashObject(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj, Object.keys(obj as object).sort())).digest("hex");
}

export const approvalManager = new ApprovalManager();