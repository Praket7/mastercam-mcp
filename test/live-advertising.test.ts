import test from "node:test";
import assert from "node:assert/strict";
import { advertisedToolDefinitions } from "../src/mcp/create-server.js";
import {
  LIVE_NATIVE_STAGE_A_TOOL_NAMES,
  SERVER_LOCAL_TOOL_NAMES
} from "../src/execution-surface.js";

test("Stage-A native surface remains exactly the verified environment tools", () => {
  assert.deepEqual(
    [...LIVE_NATIVE_STAGE_A_TOOL_NAMES].sort(),
    ["mastercam_capabilities", "mastercam_status"]
  );
});

test("live MCP discovery contains only Stage-A native tools plus server-local utilities", () => {
  const advertised = new Set(
    advertisedToolDefinitions("live").map(definition => definition.name)
  );
  const expected = new Set([
    ...LIVE_NATIVE_STAGE_A_TOOL_NAMES,
    ...SERVER_LOCAL_TOOL_NAMES
  ]);
  assert.deepEqual([...advertised].sort(), [...expected].sort());

  for (const unavailableNativeTool of [
    "get_active_part",
    "list_operations",
    "preview_operation_parameters",
    "apply_operation_parameter_preview",
    "rollback_change",
    "regenerate_toolpath"
  ]) {
    assert.equal(
      advertised.has(unavailableNativeTool),
      false,
      `${unavailableNativeTool} must not be advertised by Stage-A live mode`
    );
  }
});

test("fixture MCP discovery excludes deliberately unavailable mutations", () => {
  const names = new Set(advertisedToolDefinitions("mock").map(definition => definition.name));
  assert.equal(names.has("regenerate_toolpath"), false);
  assert.equal(names.has("change_tool"), false);
  assert.equal(names.has("update_stock"), false);
  assert.equal(names.has("apply_operation_parameter_preview"), true);
  assert.equal(names.has("rollback_change"), true);
});
