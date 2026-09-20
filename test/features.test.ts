import test from "node:test";
import assert from "node:assert/strict";
import { MockBackend } from "../src/backend.js";
import { doctor } from "../src/diagnostics.js";
import { AuditLog } from "../src/audit/audit-log.js";

const audit = () => new AuditLog({ enabled: false });

test("fixture backend supports inspect, measure, assert, preview, and rollback", async () => {
  const backend = new MockBackend({ feed: 37 }, audit());
  assert.equal(((await backend.call({ id: "1", tool: "measure", arguments: {} })) as any).data.value, 37);
  assert.equal(((await backend.call({ id: "2", tool: "assert", arguments: { equals: 37 } })) as any).data.pass, true);
  const preview = await backend.call({ id: "3", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 44, unit: "mm/min" } } } });
  assert.equal((preview.data as any).after.feedRate.value, 44);
  const apply = await backend.call({ id: "3b", tool: "apply_operation_parameter_preview", arguments: { approvalToken: (preview.data as any).approvalToken } });
  const rollbackId = (apply.data as any).rollback.transactionId;
  const rollback = await backend.call({ id: "4", tool: "rollback_change", arguments: { transactionId: rollbackId } });
  assert.equal((rollback.data as any).restored.feedRate.value, 37);
});

test("doctor reports mock prerequisites without a Mastercam license", async () => {
  const result = await doctor("\\\\.\\pipe\\mastercam-mcp-default", "mock");
  assert.equal(result.ok, true);
  assert.equal((result.data as any).checks.pipe.ok, true);
});

test("fixture feed changes stay scoped to the selected operation", async () => {
  const backend = new MockBackend({ operations: [{ id: 1, name: "Facing", feed: 30 }, { id: 2, name: "Pocket", feed: 60 }] }, audit());
  await backend.call({ id: "5", tool: "set_feed_speed", arguments: { operationId: 1, feed: 45 } });
  const result = await backend.call({ id: "6", tool: "list_operations", arguments: {} });
  assert.deepEqual((result as any).data.map((operation: any) => operation.feed.value), [45, 60]);
});

test("fixture exposes capability discovery, explanation, risks, and machine context", async () => {
  const backend = new MockBackend({ operations: [{ id: 7, name: "Pocket rough", type: "roughing", feed: 60 }] }, audit());
  const discovery = await backend.call({ id: "7a", tool: "discover_capabilities", arguments: { category: "inspection" } });
  assert.deepEqual((discovery as any).data.tools.slice(0, 2), ["get_active_part", "list_operations"]);
  const explanation = await backend.call({ id: "7b", tool: "explain_operation", arguments: { operationId: 7 } });
  assert.equal((explanation as any).data.operationId, 7);
  const risks = await backend.call({ id: "7c", tool: "get_operation_risks", arguments: { operationId: 7 } });
  assert.equal((risks as any).data.requiresConfirmation, true);
  const context = await backend.call({ id: "7d", tool: "get_machine_context", arguments: {} });
  assert.equal((context as any).data.safety, "not_verified");
});

test("fixture verifies the reread state after a feed change (BUG-04)", async () => {
  const backend = new MockBackend({ feed: 30 }, audit());
  await backend.call({ id: "8a", tool: "set_feed_speed", arguments: { feed: 45 } });
  const verified = await backend.call({ id: "8b", tool: "verify_change", arguments: { expectedFeed: 45 } });
  assert.equal(verified.ok, true);
  assert.equal((verified as any).data.verification, "verified");
});

test("verify_change with no expectation is a validation error, not NaN (BUG-04)", async () => {
  const backend = new MockBackend({ feed: 30 }, audit());
  const result = await backend.call({ id: "8c", tool: "verify_change", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "VALIDATION_FAILED");
});
