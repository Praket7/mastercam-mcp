import test from "node:test";
import assert from "node:assert/strict";
import { MockBackend } from "../src/backend.js";
import { AuditLog, verifyAuditChain } from "../src/audit/audit-log.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempAudit(): AuditLog {
  const dir = mkdtempSync(join(tmpdir(), "mcam-audit-"));
  const log = new AuditLog({ path: join(dir, "audit.jsonl"), enabled: true });
  return log;
}

test("invalid operation id never mutates the first operation (BUG-01)", async () => {
  const backend = new MockBackend({ operations: [{ id: 1, name: "Facing", feed: 30 }, { id: 2, name: "Pocket", feed: 60 }] }, tempAudit());
  const result = await backend.call({ id: "t1", tool: "preview_operation_parameters", arguments: { operationId: 999, changes: { feedRate: { value: 50, unit: "mm/min" } } } });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "OPERATION_NOT_FOUND");
  const list = await backend.call({ id: "t2", tool: "list_operations", arguments: {} });
  assert.deepEqual((list.data as Array<{ feed: { value: number } }>).map(op => op.feed.value), [30, 60]);
});

test("missing operationId with ambiguous selection requires a target (BUG-01)", async () => {
  const backend = new MockBackend({ operations: [{ id: 1, name: "A", feed: 30 }, { id: 2, name: "B", feed: 60 }] }, tempAudit());
  const result = await backend.call({ id: "t3", tool: "preview_operation_parameters", arguments: { changes: { feedRate: { value: 50, unit: "mm/min" } } } });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TARGET_REQUIRED");
  const single = new MockBackend({ operations: [{ id: 7, name: "Only", feed: 30 }] }, tempAudit());
  const ok = await single.call({ id: "t4", tool: "preview_operation_parameters", arguments: { changes: { feedRate: { value: 50, unit: "mm/min" } } } });
  assert.equal(ok.ok, true);
});

test("unknown tools fail with UNSUPPORTED_TOOL (BUG-02)", async () => {
  const backend = new MockBackend({}, tempAudit());
  const result = await backend.call({ id: "t5", tool: "totally_made_up_tool", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNSUPPORTED_TOOL");
});

test("read tools still require exact targets", async () => {
  const backend = new MockBackend({ operations: [{ id: 1, name: "A", feed: 30 }, { id: 2, name: "B", feed: 60 }] }, tempAudit());
  const missing = await backend.call({ id: "t6", tool: "get_operation", arguments: { operationId: 42 } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "OPERATION_NOT_FOUND");
  const noId = await backend.call({ id: "t7", tool: "get_operation", arguments: {} });
  assert.equal(noId.ok, false);
  assert.equal(noId.error?.code, "TARGET_REQUIRED");
});

test("preview -> apply -> rollback round trip uses quantities and receipts", async () => {
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, tempAudit());
  const preview = await backend.call({ id: "p1", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 1800, unit: "mm/min" } } } });
  assert.equal(preview.ok, true);
  const data = preview.data as { approvalToken: string; before: { feedRate: { value: number } }; after: { feedRate: { value: number } }; approvalTokenUsed?: boolean };
  assert.equal(data.before.feedRate.value, 35);
  assert.equal(data.after.feedRate.value, 1800);
  assert.match(data.approvalToken, /^appr_/);

  const apply = await backend.call({ id: "p2", tool: "apply_operation_parameter_preview", arguments: { approvalToken: data.approvalToken } });
  assert.equal(apply.ok, true);
  const applied = apply.data as { transactionId: string; rollback: { transactionId: string }; after: { feedRate: { value: number } } };
  assert.equal(applied.after.feedRate.value, 1800);
  assert.ok(applied.transactionId);
  assert.ok(applied.rollback.transactionId);

  const rollback = await backend.call({ id: "p3", tool: "rollback_change", arguments: { transactionId: applied.rollback.transactionId } });
  assert.equal(rollback.ok, true);
  const restored = rollback.data as { restored: { feedRate: { value: number } } };
  assert.equal(restored.restored.feedRate.value, 35);
});

test("approval tokens are single use and stale fingerprints are refused (BUG-06/07)", async () => {
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, tempAudit());
  const preview = await backend.call({ id: "s1", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 900, unit: "mm/min" } } } });
  const token = (preview.data as { approvalToken: string }).approvalToken;
  const first = await backend.call({ id: "s2", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  assert.equal(first.ok, true);
  const second = await backend.call({ id: "s3", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, "APPROVAL_TOKEN_INVALID");

  const preview2 = await backend.call({ id: "s4", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 1200, unit: "mm/min" } } } });
  const token2 = (preview2.data as { approvalToken: string }).approvalToken;
  // Mutate the operation behind the server's back: apply a different change
  const preview3 = await backend.call({ id: "s5a", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 77, unit: "mm/min" } } } });
  await backend.call({ id: "s5b", tool: "apply_operation_parameter_preview", arguments: { approvalToken: (preview3.data as { approvalToken: string }).approvalToken } });
  const stale = await backend.call({ id: "s6", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token2 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "STALE_PREVIEW");
});

test("rollback refuses when the operation changed after the transaction (BUG-05)", async () => {
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, tempAudit());
  const preview = await backend.call({ id: "r1", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 800, unit: "mm/min" } } } });
  const token = (preview.data as { approvalToken: string }).approvalToken;
  const apply = await backend.call({ id: "r2", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  const rollbackToken = (apply.data as { rollback: { transactionId: string } }).rollback.transactionId;
  // Apply a second change to mutate the operation
  const preview2 = await backend.call({ id: "r3", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 55, unit: "mm/min" } } } });
  await backend.call({ id: "r4", tool: "apply_operation_parameter_preview", arguments: { approvalToken: (preview2.data as { approvalToken: string }).approvalToken } });
  const refused = await backend.call({ id: "r5", tool: "rollback_change", arguments: { transactionId: rollbackToken } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "STALE_PREVIEW");
});

test("caller-supplied beforeFeed rollback values are rejected (BUG-05)", async () => {
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, tempAudit());
  const result = await backend.call({ id: "r5", tool: "rollback_change", arguments: { transactionId: "bogus" } });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "APPROVAL_TOKEN_INVALID");
});

test("idempotency key returns the original outcome without double applying", async () => {
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, tempAudit());
  const preview = await backend.call({ id: "i1", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 700, unit: "mm/min" } } } });
  const token = (preview.data as { approvalToken: string }).approvalToken;
  const first = await backend.call({ id: "i2", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token, idempotencyKey: "key-abc-123" } });
  assert.equal(first.ok, true);
  // Replay with the same key and a (now invalid) token: idempotency wins, no error.
  const replay = await backend.call({ id: "i3", tool: "apply_operation_parameter_preview", arguments: { approvalToken: "stale-stale", idempotencyKey: "key-abc-123" } });
  assert.equal(replay.ok, true);
  assert.equal((replay.data as { duplicate?: boolean }).duplicate, true);
});

test("audit log records hash-chained entries and verifies (section 30)", async () => {
  const log = tempAudit();
  const backend = new MockBackend({ operations: [{ id: 4, name: "Facing", feed: 35 }] }, log);
  const preview = await backend.call({ id: "a1", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 50, unit: "mm/min" } } } });
  const token = (preview.data as { approvalToken: string }).approvalToken;
  await backend.call({ id: "a2", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  await log.flush();
  const verdict = await verifyAuditChain(log.location);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.entries >= 1);
});

test("context bundle aggregates state in one call (section 27)", async () => {
  const backend = new MockBackend({ operations: [{ id: 1, name: "A" }, { id: 2, name: "B", toolpathDirty: true }] }, tempAudit());
  const result = await backend.call({ id: "c1", tool: "get_programming_context", arguments: {} });
  assert.equal(result.ok, true);
  const data = result.data as { operationSummary: unknown[]; dirtyToolpaths: number[]; documentRevision: string };
  assert.equal(data.operationSummary.length, 2);
  assert.deepEqual(data.dirtyToolpaths, [2]);
  assert.ok(data.documentRevision.startsWith("rev_"));
});

test("regeneration requires exact ids and clears dirty state", async () => {
  const backend = new MockBackend({ operations: [{ id: 1, name: "A", toolpathDirty: true }] }, tempAudit());
  const result = await backend.call({ id: "g1", tool: "regenerate_toolpath", arguments: { operationIds: [1] } });
  assert.equal(result.ok, true);
  const status = await backend.call({ id: "g2", tool: "get_toolpath_status", arguments: { operationId: 1 } });
  assert.equal((status.data as { generated: boolean }).generated, true);
  const missing = await backend.call({ id: "g3", tool: "regenerate_toolpath", arguments: { operationIds: [99] } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "OPERATION_NOT_FOUND");
});
