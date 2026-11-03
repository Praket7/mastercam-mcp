import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MockBackend } from "../src/backend.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { ApprovalLedger } from "../src/safety/approval.js";

function auditFixture() {
  const dir = mkdtempSync(join(tmpdir(), "mcam-audit-semantics-"));
  const path = join(dir, "audit.jsonl");
  return { path, log: new AuditLog({ path, enabled: true }) };
}

test("recent audit history crosses retained rotations and omits rotation markers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcam-audit-history-"));
  const log = new AuditLog({ path: join(dir, "audit.jsonl"), enabled: true, maxFileBytes: 350, maxRotatedFiles: 2 });
  for (let index = 1; index <= 8; index++) {
    log.record({ requestId: `history-${index}`, tool: "preview_operation_parameters" });
  }

  const history = await log.getRecentEntries(3);
  assert.equal(history.integrity, "verified");
  assert.deepEqual(history.entries.map(entry => entry.requestId), ["history-6", "history-7", "history-8"]);
  assert.equal(history.entries.some(entry => entry.tool === "audit_rotation"), false);
});

test("AuditLog uses the same case-insensitive audit setting as server config", () => {
  const previous = process.env.MASTERCAM_MCP_AUDIT;
  try {
    process.env.MASTERCAM_MCP_AUDIT = "FALSE";
    assert.equal(new AuditLog({ path: join(tmpdir(), "unused-audit.jsonl") }).isEnabled, false);
    process.env.MASTERCAM_MCP_AUDIT = "1";
    assert.equal(new AuditLog({ path: join(tmpdir(), "unused-audit.jsonl") }).isEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_AUDIT;
    else process.env.MASTERCAM_MCP_AUDIT = previous;
  }
});

test("recent audit history fails closed if a retained entry is modified", async () => {
  const { path, log } = auditFixture();
  log.record({ requestId: "tamper-check", tool: "preview_operation_parameters" });
  await log.flush();
  const content = readFileSync(path, "utf8");
  writeFileSync(path, content.replace("preview_operation_parameters", "changed_tool_name"));

  const history = await log.getRecentEntries(10);
  assert.equal(history.integrity, "failed");
  assert.deepEqual(history.entries, []);
});

test("apply is audited as unverified and reread verification is a separate linked event", async () => {
  const { path, log } = auditFixture();
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, log);

  const preview = await backend.call({
    id: "audit-preview",
    tool: "preview_operation_parameters",
    arguments: { operationId: 4, changes: { feedRate: { value: 600, unit: "mm/min" } } }
  });
  assert.equal(preview.ok, true);
  const approvalToken = (preview.data as { approvalToken: string }).approvalToken;

  const apply = await backend.call({
    id: "audit-apply",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken }
  });
  assert.equal(apply.ok, true);
  const applied = apply.data as { transactionId: string; documentRevision: string };

  const verify = await backend.call({
    id: "audit-verify",
    tool: "verify_change",
    arguments: {
      operationId: 4,
      transactionId: applied.transactionId,
      expected: { feedRate: { value: 600, unit: "mm/min" } }
    }
  });
  assert.equal(verify.ok, true);
  await log.flush();

  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const applyEntry = entries.find(entry => entry.requestId === "audit-apply");
  const verifyEntry = entries.find(entry => entry.requestId === "audit-verify");

  assert.equal(applyEntry?.verified, false);
  assert.equal(applyEntry?.transactionId, applied.transactionId);
  assert.equal(verifyEntry?.verified, true);
  assert.equal(verifyEntry?.transactionId, applied.transactionId);
});

test("verification transaction cannot be attached to a different operation", async () => {
  const backend = new MockBackend({
    operations: [
      { id: 1, name: "One", feed: 35 },
      { id: 2, name: "Two", feed: 45 }
    ]
  }, auditFixture().log);

  const preview = await backend.call({
    id: "link-preview",
    tool: "preview_operation_parameters",
    arguments: { operationId: 1, changes: { feedRate: { value: 100, unit: "mm/min" } } }
  });
  const approvalToken = (preview.data as { approvalToken: string }).approvalToken;
  const apply = await backend.call({
    id: "link-apply",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken }
  });
  const transactionId = (apply.data as { transactionId: string }).transactionId;

  const wrongTarget = await backend.call({
    id: "link-verify",
    tool: "verify_change",
    arguments: {
      operationId: 2,
      transactionId,
      expected: { feedRate: { value: 45, unit: "mm/min" } }
    }
  });
  assert.equal(wrongTarget.ok, false);
  assert.equal(wrongTarget.error?.code, "VALIDATION_FAILED");
});

test("approval transactions and rollback receipts expire instead of living forever", async () => {
  const ledger = new ApprovalLedger(5);
  const preview = ledger.createPreview({
    tool: "preview_operation_parameters",
    operationId: 1,
    changes: { feedRate: { value: 50, unit: "mm/min" } },
    before: { feedRate: { value: 35, unit: "mm/min" } },
    after: { feedRate: { value: 50, unit: "mm/min" } },
    documentRevision: "rev-1",
    operationFingerprint: "fp-1",
    beforeHash: "before",
    afterHash: "after",
    requiresRegeneration: true
  });
  const consumed = ledger.consumePreview(preview.approvalToken, {
    operationFingerprint: "fp-1",
    documentRevision: "rev-1"
  });
  const applied = ledger.recordApply(consumed);
  const rollback = ledger.createRollback(applied.transactionId);

  await delay(15);
  assert.throws(() => ledger.peekApplied(applied.transactionId), /unknown or expired applied transaction/);
  assert.throws(() => ledger.peekRollback(rollback.transactionId), /unknown or already consumed rollback transaction/);
});
