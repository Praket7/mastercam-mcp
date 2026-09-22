import test from "node:test";
import assert from "node:assert/strict";
import { MockBackend } from "../src/backend.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { doctor } from "../src/diagnostics.js";

function testBackend(fixture?: ConstructorParameters<typeof MockBackend>[0]): MockBackend {
  return new MockBackend(fixture, new AuditLog({ enabled: false }));
}

test("fixture backend supports inspect, measure, assert, preview, and rollback", async () => {
  const backend = testBackend({ feed: 37 });
  const measureResult = await backend.call({ id: "1", tool: "measure", arguments: { operationId: 4 } });
  assert.equal((measureResult as any).data.value, 37);
  const assertResult = await backend.call({ id: "2", tool: "assert", arguments: { operationId: 4, equals: 37 } });
  assert.equal((assertResult as any).data.pass, true);
  const preview = await backend.call({ id: "3", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 44, unit: "mm/min" } } } });
  assert.equal((preview as any).data.after.feedRate.value, 44);
  const rollback = await backend.call({ id: "4", tool: "rollback_change", arguments: { transactionId: "invalid" } });
  assert.equal(rollback.ok, false);
  assert.equal((rollback as any).error.code, "APPROVAL_TOKEN_INVALID");
});

test("doctor reports mock prerequisites without a Mastercam license", async () => {
  const result = await doctor("\\\\.\\pipe\\mastercam-mcp-default", "mock");
  assert.equal(result.ok, true);
  assert.equal((result.data as any).checks.pipe.ok, true);
});

test("fixture feed changes stay scoped to the selected operation", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Facing", feed: { value: 30, unit: "mm/min" } }, { id: 2, name: "Pocket", feed: { value: 60, unit: "mm/min" } }] });
  const preview = await backend.call({ id: "5", tool: "preview_operation_parameters", arguments: { operationId: 1, changes: { feedRate: { value: 45, unit: "mm/min" } } } });
  assert.ok((preview as any).data.approvalToken);
  const apply = await backend.call({ id: "6", tool: "apply_operation_parameter_preview", arguments: { approvalToken: (preview as any).data.approvalToken } });
  assert.equal(apply.ok, true);
  const result = await backend.call({ id: "7", tool: "list_operations", arguments: {} });
  assert.deepEqual((result as any).data.map((operation: any) => operation.feed?.value), [45, 60]);
});

test("fixture exposes capability discovery, explanation, risks, and machine context", async () => {
  const backend = testBackend({ operations: [{ id: 7, name: "Pocket rough", type: "roughing", feedRate: { value: 60, unit: "mm/min" } }] });
  const discovery = await backend.call({ id: "7a", tool: "discover_capabilities", arguments: { category: "inspection" } });
  assert.deepEqual((discovery as any).data.tools.slice(0, 2), ["get_active_part", "list_operations"]);
  const explanation = await backend.call({ id: "7b", tool: "explain_operation", arguments: { operationId: 7 } });
  assert.equal((explanation as any).data.operationId, 7);
  const risks = await backend.call({ id: "7c", tool: "get_operation_risks", arguments: { operationId: 7 } });
  assert.equal((risks as any).data.requiresConfirmation, true);
  const context = await backend.call({ id: "7d", tool: "get_machine_context", arguments: {} });
  assert.equal((context as any).data.safety, "not_verified");
});

test("fixture verifies the reread state after a feed change", async () => {
  const backend = testBackend({ feed: 30 });
  const preview = await backend.call({ id: "8a", tool: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 45, unit: "mm/min" } } } });
  const apply = await backend.call({ id: "8b", tool: "apply_operation_parameter_preview", arguments: { approvalToken: (preview as any).data.approvalToken } });
  assert.equal(apply.ok, true);
  const verified = await backend.call({ id: "8c", tool: "verify_change", arguments: { operationId: 4, expected: { feedRate: { value: 45, unit: "mm/min" } } } });
  assert.equal(verified.ok, true);
  assert.equal((verified as any).data.verification, "verified");
});

test("invalid operation ID returns OPERATION_NOT_FOUND", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Op1" }, { id: 2, name: "Op2" }] });
  const result = await backend.call({ id: "9", tool: "get_operation", arguments: { operationId: 999 } });
  assert.equal(result.ok, false);
  assert.equal((result as any).error.code, "OPERATION_NOT_FOUND");
});

test("unknown tool returns UNSUPPORTED_TOOL", async () => {
  const backend = testBackend();
  const result = await backend.call({ id: "10", tool: "nonexistent_tool", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal((result as any).error.code, "UNSUPPORTED_TOOL");
});

test("preview requires at least one parameter", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Op1", feedRate: { value: 30, unit: "mm/min" } }] });
  const result = await backend.call({ id: "11", tool: "preview_operation_parameters", arguments: { operationId: 1 } });
  assert.equal(result.ok, false);
  assert.equal((result as any).error.code, "VALIDATION_FAILED");
});

test("verify_change requires expected values", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Op1", feedRate: { value: 30, unit: "mm/min" } }] });
  const result = await backend.call({ id: "12", tool: "verify_change", arguments: { operationId: 1 } });
  assert.equal(result.ok, false);
  assert.equal((result as any).error.code, "VALIDATION_FAILED");
});

test("rollback requires transactionId", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Op1", feedRate: { value: 30, unit: "mm/min" } }] });
  const result = await backend.call({ id: "13", tool: "rollback_change", arguments: { transactionId: "" } });
  assert.equal(result.ok, false);
});

test("approval token can only be used once", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Op1", feedRate: { value: 30, unit: "mm/min" } }] });
  const preview = await backend.call({ id: "14", tool: "preview_operation_parameters", arguments: { operationId: 1, changes: { feedRate: { value: 45, unit: "mm/min" } } } });
  const token = (preview as any).data.approvalToken;
  const apply1 = await backend.call({ id: "15", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  assert.equal(apply1.ok, true);
  const apply2 = await backend.call({ id: "16", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  assert.equal(apply2.ok, false);
  assert.equal((apply2 as any).error.code, "APPROVAL_TOKEN_INVALID");
});

test("stale preview is rejected", async () => {
  const backend = testBackend({ operations: [{ id: 1, name: "Op1", feed: { value: 30, unit: "mm/min" } }] });
  const preview = await backend.call({ id: "17", tool: "preview_operation_parameters", arguments: { operationId: 1, changes: { feedRate: { value: 45, unit: "mm/min" } } } });
  const token = (preview as any).data.approvalToken;
  // Apply a different change to mutate the operation
  const preview2 = await backend.call({ id: "18", tool: "preview_operation_parameters", arguments: { operationId: 1, changes: { feedRate: { value: 50, unit: "mm/min" } } } });
  await backend.call({ id: "19", tool: "apply_operation_parameter_preview", arguments: { approvalToken: (preview2.data as { approvalToken: string }).approvalToken } });
  const apply = await backend.call({ id: "20", tool: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
  assert.equal(apply.ok, false);
  assert.equal((apply as any).error.code, "STALE_PREVIEW");
});