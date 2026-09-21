import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../src/safety/approval.js";
import { computeDocumentFingerprint, computeOperationFingerprint, generateRevision, isStale } from "../src/safety/revisions.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("ApprovalManager creates and validates approvals", () => {
  const mgr = new ApprovalManager();
  const approval = mgr.createApproval(1, "fp-1", "rev-1", { feedRate: { value: 100, unit: "mm/min" } }, { feedRate: { value: 200, unit: "mm/min" } });
  assert.ok(approval.approvalToken);
  assert.ok(approval.transactionId);

  const validation = mgr.validateApproval(approval.approvalToken, "fp-1", "rev-1");
  assert.ok(validation.approval);
  assert.equal(validation.approval.operationId, 1);

  mgr.markUsed(approval.approvalToken);
  const reused = mgr.validateApproval(approval.approvalToken, "fp-1", "rev-1");
  assert.ok(!reused.approval);
  assert.equal(reused.error, "APPROVAL_TOKEN_USED");
});

test("ApprovalManager rejects stale fingerprint", () => {
  const mgr = new ApprovalManager();
  const approval = mgr.createApproval(1, "fp-1", "rev-1", { feedRate: { value: 100, unit: "mm/min" } }, { feedRate: { value: 200, unit: "mm/min" } });
  const validation = mgr.validateApproval(approval.approvalToken, "fp-2", "rev-1");
  assert.ok(!validation.approval);
  assert.equal(validation.error, "STALE_PREVIEW");
});

test("ApprovalManager rejects stale revision", () => {
  const mgr = new ApprovalManager();
  const approval = mgr.createApproval(1, "fp-1", "rev-1", { feedRate: { value: 100, unit: "mm/min" } }, { feedRate: { value: 200, unit: "mm/min" } });
  const validation = mgr.validateApproval(approval.approvalToken, "fp-1", "rev-2");
  assert.ok(!validation.approval);
  assert.equal(validation.error, "STALE_PREVIEW");
});

test("computeOperationFingerprint is deterministic", () => {
  const op = { id: 1, name: "Test", feedRate: { value: 100, unit: "mm/min" } };
  assert.equal(computeOperationFingerprint(op), computeOperationFingerprint(op));
});

test("computeDocumentFingerprint changes when operations change", () => {
  const ops1 = [{ id: 1, feedRate: { value: 100, unit: "mm/min" } }];
  const ops2 = [{ id: 1, feedRate: { value: 200, unit: "mm/min" } }];
  assert.notEqual(computeDocumentFingerprint(ops1), computeDocumentFingerprint(ops2));
});

test("generateRevision produces unique values", () => {
  const revs = new Set<string>();
  for (let i = 0; i < 100; i++) revs.add(generateRevision());
  assert.equal(revs.size, 100);
});

test("isStale detects revision changes", () => {
  assert.ok(isStale("rev-1", "rev-2"));
  assert.ok(!isStale("rev-1", "rev-1"));
});

test("AuditLog appends and queries entries", () => {
  const path = join(tmpdir(), `test-audit-${Date.now()}.jsonl`);
  const log = new AuditLog(path, 10);
  log.append({ requestId: "req-1", transactionId: "tx-1", tool: "test_tool", target: { operationId: 1 }, policy: {}, beforeHash: "hash1", afterHash: "hash2", verified: true });
  const result = log.query({ limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].tool, "test_tool");
});

test("AuditLog verifies hash chain", () => {
  const path = join(tmpdir(), `test-audit-${Date.now()}.jsonl`);
  const log = new AuditLog(path, 10);
  log.append({ requestId: "req-1", transactionId: "tx-1", tool: "tool1", target: {}, policy: {}, verified: true });
  log.append({ requestId: "req-2", transactionId: "tx-2", tool: "tool2", target: {}, policy: {}, verified: true });
  const verification = log.verifyChain();
  assert.ok(verification.valid);
});