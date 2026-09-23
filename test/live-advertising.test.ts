import test from "node:test";
import assert from "node:assert/strict";
import { advertisedToolDefinitions } from "../src/mcp/create-server.js";
import {
  LIVE_NATIVE_STAGE_A_TOOL_NAMES,
  LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES,
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


test("Stage-B native reads are hidden by default and opt-in explicitly", () => {
  const previous = process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS;
  try {
    delete process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS;
    const defaultNames = new Set(advertisedToolDefinitions("live").map(definition => definition.name));
    for (const name of LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES) {
      assert.equal(defaultNames.has(name), false, `${name} must remain hidden without explicit Stage-B opt-in`);
    }

    process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS = "1";
    const enabledNames = new Set(advertisedToolDefinitions("live").map(definition => definition.name));
    for (const name of LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES) {
      assert.equal(enabledNames.has(name), true, `${name} must be advertised after explicit Stage-B opt-in`);
    }
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS;
    else process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS = previous;
  }
});
