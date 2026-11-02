import test from "node:test";
import assert from "node:assert/strict";
import { advertisedToolDefinitions, discoverCapabilitiesPayload } from "../src/mcp/create-server.js";
import {
  LIVE_NATIVE_STAGE_A_TOOL_NAMES,
  LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES,
  SERVER_LOCAL_TOOL_NAMES
} from "../src/execution-surface.js";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";

test("Stage-A native bridge calls remain exactly the environment checks", () => {
  assert.deepEqual(
    [...LIVE_NATIVE_STAGE_A_TOOL_NAMES].sort(),
    ["mastercam_capabilities", "mastercam_status"]
  );
});

test("the local audit-history tool is available in live mode without a Mastercam mapping", () => {
  assert.equal(SERVER_LOCAL_TOOL_NAMES.has("get_audit_history"), true);
  assert.equal(advertisedToolDefinitions("live", undefined, "full").some(tool => tool.name === "get_audit_history"), true);
});

test("live MCP discovery contains only Stage-A native tools plus server-local utilities", () => {
  const advertised = new Set(advertisedToolDefinitions("live", undefined, "full").map(definition => definition.name));
  const registered = new Set(TOOL_DEFINITIONS.map(definition => definition.name));
  const expected = new Set([...SERVER_LOCAL_TOOL_NAMES, ...LIVE_NATIVE_STAGE_A_TOOL_NAMES].filter(name => registered.has(name)));
  assert.deepEqual([...advertised].sort(), [...expected].sort());
  assert.equal(advertised.has("get_server_readiness"), true);
  assert.equal(advertised.has("get_job_context"), true);

  for (const unavailableNativeTool of [
    "get_active_part",
    "get_programming_context",
    "mastercam_status",
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
    const registered = new Set(TOOL_DEFINITIONS.map(definition => definition.name));
    const publicStageB = [...LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES].filter(name => registered.has(name));
    const defaultNames = new Set(advertisedToolDefinitions("live", undefined, "full").map(definition => definition.name));
    for (const name of publicStageB) {
      assert.equal(defaultNames.has(name), false, `${name} must remain hidden without explicit Stage-B opt-in`);
    }

    process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS = "1";
    const enabledNames = new Set(advertisedToolDefinitions("live", undefined, "full").map(definition => definition.name));
    for (const name of publicStageB) {
      assert.equal(enabledNames.has(name), true, `${name} must be advertised after explicit Stage-B opt-in`);
    }
    assert.equal(enabledNames.has("get_programming_context"), false, "the raw overlapping context call stays internal");
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS;
    else process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS = previous;
  }
});

test("live capability discovery identifies Stage-B reads and keeps verification limits explicit", () => {
  const previous = process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS;
  try {
    process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS = "1";
    const definitions = advertisedToolDefinitions("live", undefined, "full");
    const report = discoverCapabilitiesPayload({}, definitions, "live") as {
      tools: Array<{ name: string; execution: string }>;
      nativeStage: string;
      note: string;
    };
    assert.equal(report.tools.find(tool => tool.name === "list_operations")?.execution, "native-stage-b");
    assert.equal(report.tools.find(tool => tool.name === "analyze_nc_program")?.execution, "server-local");
    assert.match(report.nativeStage, /Stage B/i);
    assert.match(report.note, /IMPLEMENTED/i);
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS;
    else process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS = previous;
  }
});
