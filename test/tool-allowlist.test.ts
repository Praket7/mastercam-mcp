import test from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { advertisedToolDefinitions } from "../src/mcp/create-server.js";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";
import { allowed } from "../src/contracts.js";

test("the default toolset is a curated compact catalog and full mode preserves specialists", () => {
  const compact = advertisedToolDefinitions("mock");
  assert.equal(compact.length, 24);
  assert.deepEqual(advertisedToolDefinitions("mock", undefined, "full"), TOOL_DEFINITIONS);
  assert.equal(ConfigSchema.parse({}).toolAllowlist, undefined);
  assert.equal(ConfigSchema.parse({}).toolset, "compact");
});

test("an allowlist selects only requested tools in canonical order without duplicates", () => {
  assert.deepEqual(
    advertisedToolDefinitions("mock", ["calculate_thread_tap", "get_server_readiness", "get_server_readiness"])
      .map(tool => tool.name),
    ["get_server_readiness", "calculate_thread_tap"]
  );
  assert.deepEqual(advertisedToolDefinitions("mock", []), []);
});

test("selection cannot advertise a native mapping hidden by the live backend", () => {
  assert.deepEqual(
    advertisedToolDefinitions("live", ["get_server_readiness", "list_operations", "apply_operation_parameter_preview"])
      .map(tool => tool.name),
    ["get_server_readiness"]
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
    process.env.MASTERCAM_MCP_TOOLS = " get_server_readiness, calculate_thread_tap,get_server_readiness ";
    assert.deepEqual(loadConfig().toolAllowlist, ["get_server_readiness", "calculate_thread_tap", "get_server_readiness"]);
    process.env.MASTERCAM_MCP_TOOLS = " , ";
    assert.deepEqual(loadConfig().toolAllowlist, []);
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_TOOLS;
    else process.env.MASTERCAM_MCP_TOOLS = previous;
  }
});

test("boolean environment settings are case-insensitive and reject invalid values", () => {
  const previous = process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE;
  try {
    process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE = "FALSE";
    assert.equal(loadConfig().http.allowRemote, false);
    process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE = " 1 ";
    assert.equal(loadConfig().http.allowRemote, true);
    process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE = "truue";
    assert.throws(() => loadConfig(), /MASTERCAM_MCP_HTTP_ALLOW_REMOTE.*true.*false/i);
  } finally {
    if (previous === undefined) delete process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE;
    else process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE = previous;
  }
});
