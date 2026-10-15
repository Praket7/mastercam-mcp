import test from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { advertisedToolDefinitions } from "../src/mcp/create-server.js";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";
import { allowed } from "../src/contracts.js";

test("an unset allowlist keeps the existing fixture catalog", () => {
  assert.deepEqual(advertisedToolDefinitions("mock"), TOOL_DEFINITIONS);
  assert.equal(ConfigSchema.parse({}).toolAllowlist, undefined);
});

test("an allowlist selects only requested tools in canonical order without duplicates", () => {
  assert.deepEqual(
    advertisedToolDefinitions("mock", ["calculate_thread_tap", "mastercam_status", "mastercam_status"])
      .map(tool => tool.name),
    ["mastercam_status", "calculate_thread_tap"]
  );
  assert.deepEqual(advertisedToolDefinitions("mock", []), []);
});

test("selection cannot advertise a native mapping hidden by the live backend", () => {
  assert.deepEqual(
    advertisedToolDefinitions("live", ["mastercam_status", "get_active_part", "apply_operation_parameter_preview"])
      .map(tool => tool.name),
    ["mastercam_status"]
  );
});

test("unknown and deliberately unregistered tools fail instead of silently broadening selection", () => {
  for (const name of ["calculate_thread_typo", "post_program", "regenerate_toolpath", "*"]) {
    assert.throws(() => advertisedToolDefinitions("mock", [name]), /unknown or unregistered tool/);
  }
});

test("selecting a write tool does not change the existing profile policy", () => {
  const name = "apply_operation_parameter_preview";
  assert.equal(advertisedToolDefinitions("mock", [name])[0]?.name, name);
  assert.equal(allowed(name, "read", false), false);
  assert.equal(allowed(name, "write", true), false);
  assert.equal(allowed(name, "write", false), true);
});

test("the environment trims names and keeps explicit empty selection distinct from unset", () => {
  const previous = process.env.MASTERCAM_MCP_TOOLS;
  try {
    delete process.env.MASTERCAM_MCP_TOOLS;
    assert.equal(loadConfig().toolAllowlist, undefined);
    process.env.MASTERCAM_MCP_TOOLS = " mastercam_status, calculate_thread_tap,mastercam_status ";
    assert.deepEqual(loadConfig().toolAllowlist, ["mastercam_status", "calculate_thread_tap", "mastercam_status"]);
    process.env.MASTERCAM_MCP_TOOLS = " , ";
    assert.deepEqual(loadConfig().toolAllowlist, []);
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_TOOLS;
    else process.env.MASTERCAM_MCP_TOOLS = previous;
  }
});
