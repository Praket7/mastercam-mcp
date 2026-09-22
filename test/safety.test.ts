import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalLedger, fingerprintOperation, documentRevision } from "../src/safety/approval.js";
import { AuditLog, redact } from "../src/audit/audit-log.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

function previewInput(operationId: number) {
  return {
    tool: "preview_operation_parameters",
    operationId,
    changes: { feedRate: { value: 200, unit: "mm/min" } },
    before: { feedRate: { value: 100, unit: "mm/min" } },
    after: { feedRate: { value: 200, unit: "mm/min" } },
    documentRevision: `rev-${operationId}`,
    operationFingerprint: `fp-${operationId}`,
    beforeHash: `h${operationId}-before`,
    afterHash: `h${operationId}-after`,
    requiresRegeneration: true
  };
}

test("ApprovalLedger creates and validates approvals", () => {
  const ledger = new ApprovalLedger();
  const preview = ledger.createPreview(previewInput(1));
  assert.ok(preview.approvalToken.startsWith("appr_"));
  const peeked = ledger.peekPreview(preview.approvalToken);
  assert.equal(peeked.operationId, 1);
  const consumed = ledger.consumePreview(preview.approvalToken, { operationFingerprint: "fp-1", documentRevision: "rev-1" });
  assert.equal(consumed.operationId, 1);
  assert.throws(() => ledger.consumePreview(preview.approvalToken, { operationFingerprint: "fp-1", documentRevision: "rev-1" }), /APPROVAL_TOKEN_INVALID/);
});

test("ApprovalLedger rejects stale fingerprint", () => {
  const ledger = new ApprovalLedger();
  const preview = ledger.createPreview(previewInput(1));
  assert.throws(() => ledger.consumePreview(preview.approvalToken, { operationFingerprint: "fp-2", documentRevision: "rev-1" }), /STALE_PREVIEW/);
});

test("ApprovalLedger rejects stale revision", () => {
  const ledger = new ApprovalLedger();
  const preview = ledger.createPreview(previewInput(1));
  assert.throws(() => ledger.consumePreview(preview.approvalToken, { operationFingerprint: "fp-1", documentRevision: "rev-2" }), /STALE_PREVIEW/);
});

test("ApprovalLedger evicts oldest preview when its configured bound is exceeded", () => {
  const ledger = new ApprovalLedger(60_000, 2);
  const first = ledger.createPreview(previewInput(1));
  const second = ledger.createPreview(previewInput(2));
  const third = ledger.createPreview(previewInput(3));
  assert.throws(() => ledger.peekPreview(first.approvalToken), /APPROVAL_TOKEN_INVALID/);
  assert.equal(ledger.peekPreview(second.approvalToken).operationId, 2);
  assert.equal(ledger.peekPreview(third.approvalToken).operationId, 3);
});

test("fingerprintOperation is deterministic", () => {
  const op = { id: 1, feed: { value: 100, unit: "mm/min" } };
  assert.equal(fingerprintOperation(1, op), fingerprintOperation(1, op));
});

test("documentRevision changes when operations change", () => {
  const ops1 = [{ id: 1, feed: { value: 100, unit: "mm/min" } }];
  const ops2 = [{ id: 1, feed: { value: 200, unit: "mm/min" } }];
  assert.notEqual(documentRevision(ops1), documentRevision(ops2));
});

test("audit redaction never returns raw deep object tails", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { accessToken: "should-never-appear", value: "also-hidden-by-depth-limit" } } } } } } } };
  const sanitized = redact(deep);
  const text = JSON.stringify(sanitized);
  assert.equal(text.includes("should-never-appear"), false);
  assert.equal(text.includes("also-hidden-by-depth-limit"), false);
  assert.equal(text.includes("[truncated]"), true);
});

test("audit redaction recognizes common credential key variants", () => {
  const sanitized = redact({ apiKey: "a", client_secret: "b", cookie: "c", sessionId: "d", privateKey: "e" }) as Record<string, unknown>;
  assert.deepEqual(sanitized, {
    apiKey: "[redacted]",
    client_secret: "[redacted]",
    cookie: "[redacted]",
    sessionId: "[redacted]",
    privateKey: "[redacted]"
  });
});

test("AuditLog appends and queries entries", async () => {
  const path = join(tmpdir(), `test-audit-${Date.now()}.jsonl`);
  const log = new AuditLog({ path, enabled: true });
  log.record({ requestId: "req-1", transactionId: "tx-1", tool: "test_tool", target: { operationId: 1 }, policy: {} });
  await log.flush();
  const result = await import("node:fs/promises").then(m => m.readFile(path, "utf8")).then(t => t.trim().split("\n").filter(Boolean).length);
  assert.equal(result, 1);
});

test("AuditLog recordCritical waits for durable append", async () => {
  const path = join(tmpdir(), `test-audit-critical-${Date.now()}.jsonl`);
  const log = new AuditLog({ path, enabled: true });
  const entry = await log.recordCritical({ requestId: "critical-1", tool: "apply_operation_parameter_preview", verified: false });
  assert.equal(entry.sequence, 1);
  const text = await import("node:fs/promises").then(m => m.readFile(path, "utf8"));
  assert.match(text, /apply_operation_parameter_preview/);
});

test("AuditLog verifies hash chain", async () => {
  const path = join(tmpdir(), `test-audit-${Date.now()}.jsonl`);
  const log = new AuditLog({ path, enabled: true });
  log.record({ requestId: "req-1", tool: "tool1", target: {} });
  log.record({ requestId: "req-2", tool: "tool2", target: {} });
  await log.flush();
  const { verifyAuditChain } = await import("../src/audit/audit-log.js");
  const verification = await verifyAuditChain(path);
  assert.ok(verification.ok);
});

test("AuditLog resumes a valid chain across restart", async () => {
  const path = join(tmpdir(), `test-audit-restart-${Date.now()}.jsonl`);
  const first = new AuditLog({ path, enabled: true });
  first.record({ requestId: "r1", tool: "first" });
  await first.flush();

  const second = new AuditLog({ path, enabled: true });
  assert.equal(second.integrityError, undefined);
  second.record({ requestId: "r2", tool: "second" });
  await second.flush();

  const { verifyAuditChain } = await import("../src/audit/audit-log.js");
  const verdict = await verifyAuditChain(path);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.entries, 2);
});

test("AuditLog rotation preserves an anchored hash chain", async () => {
  const path = join(tmpdir(), `test-audit-rotate-${Date.now()}.jsonl`);
  const log = new AuditLog({ path, enabled: true, maxFileBytes: 350, maxRotatedFiles: 2 });
  for (let i = 0; i < 8; i++) {
    log.record({ requestId: `rot-${i}`, tool: "rotation_test", target: { i, padding: "x".repeat(80) } });
  }
  await log.flush();

  const fs = await import("node:fs/promises");
  const { verifyAuditChain } = await import("../src/audit/audit-log.js");
  const current = await verifyAuditChain(path);
  const rotated = await verifyAuditChain(`${path}.1`);
  assert.equal(current.ok, true);
  assert.equal(rotated.ok, true);
  assert.ok(current.anchor);
  assert.equal(current.anchor, rotated.finalHash);
  await fs.rm(path, { force: true });
  await fs.rm(`${path}.1`, { force: true });
  await fs.rm(`${path}.2`, { force: true });
});
