import test from "node:test";
import assert from "node:assert/strict";
import { allowed } from "../src/contracts.js";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { parseHardReadOnly, validateProfileConfig } from "../src/safety/policy.js";

test("read tools are always allowed", () => assert.equal(allowed("mastercam_status", "read", true), true));
test("hard read only blocks writes", () => assert.equal(allowed("apply_operation_parameter_preview", "write", true), false));
test("write profile still requires the explicit hard-read-only opt-out", () => assert.equal(allowed("apply_operation_parameter_preview", "write", ConfigSchema.parse({ profile: "write" }).hardReadOnly), false));
test("posting is blocked by default", () => assert.equal(allowed("post_program", "all", false), false));
test("read profile blocks writes", () => assert.equal(allowed("apply_operation_parameter_preview", "read", false), false));
test("all profile allows advanced", () => assert.equal(allowed("run_simulation", "all", false), true));
test("unknown tool is not allowed", () => assert.equal(allowed("unknown_tool", "read", false), false));
test("hard read only is the schema default", () => assert.equal(ConfigSchema.parse({}).hardReadOnly, true));
test("only the exact zero setting disables hard read only", () => {
  for (const value of [undefined, "", "false", "1", "invalid"]) assert.equal(parseHardReadOnly(value), true);
  assert.equal(parseHardReadOnly("0"), false);
});
test("profile and hard read only switches must both explicitly allow a write", () => {
  const defaulted = validateProfileConfig("write", "1");
  const enabled = validateProfileConfig("write", "0");
  assert.equal(allowed("apply_operation_parameter_preview", defaulted.profile, defaulted.hardReadOnly), false);
  assert.equal(allowed("apply_operation_parameter_preview", enabled.profile, enabled.hardReadOnly), true);
});
test("write profile with an unset or invalid hard-read-only value stays locked", () => {
  const oldProfile = process.env.MASTERCAM_MCP_PROFILE;
  const oldHardReadOnly = process.env.MASTERCAM_MCP_HARD_READ_ONLY;
  try {
    process.env.MASTERCAM_MCP_PROFILE = "write";
    delete process.env.MASTERCAM_MCP_HARD_READ_ONLY;
    assert.equal(loadConfig().hardReadOnly, true);
    process.env.MASTERCAM_MCP_HARD_READ_ONLY = "false";
    assert.equal(loadConfig().hardReadOnly, true);
    process.env.MASTERCAM_MCP_HARD_READ_ONLY = "0";
    assert.equal(loadConfig().hardReadOnly, false);
  } finally {
    if (oldProfile === undefined) delete process.env.MASTERCAM_MCP_PROFILE;
    else process.env.MASTERCAM_MCP_PROFILE = oldProfile;
    if (oldHardReadOnly === undefined) delete process.env.MASTERCAM_MCP_HARD_READ_ONLY;
    else process.env.MASTERCAM_MCP_HARD_READ_ONLY = oldHardReadOnly;
  }
});
