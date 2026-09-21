import test from "node:test";
import assert from "node:assert/strict";
import { allowed, validateProfileConfig } from "../src/contracts.js";
import { createSafetyPolicy, checkToolAllowed } from "../src/safety/policy.js";

test("read tools are always allowed", () => assert.equal(allowed("mastercam_status", "read", true, false), true));
test("hard read only blocks writes", () => assert.equal(allowed("apply_operation_parameter_preview", "core", true, false), false));
test("write profile allows dry run", () => assert.equal(allowed("apply_operation_parameter_preview", "core", false, true), true));
test("posting is blocked by default", () => assert.equal(allowed("post_program", "dev", false, false), false));

test("validateProfileConfig accepts valid profiles", () => {
  assert.deepEqual(validateProfileConfig("read", "1"), { profile: "read", hardReadOnly: true });
  assert.deepEqual(validateProfileConfig("core", "0"), { profile: "core", hardReadOnly: false });
  assert.deepEqual(validateProfileConfig("write", "1"), { profile: "write", hardReadOnly: true });
  assert.deepEqual(validateProfileConfig("advanced", "0"), { profile: "advanced", hardReadOnly: false });
  assert.deepEqual(validateProfileConfig("dev", "0"), { profile: "dev", hardReadOnly: false });
});

test("validateProfileConfig rejects invalid profile", () => {
  assert.throws(() => validateProfileConfig("invalid", "1"), /Invalid profile/);
});

test("createSafetyPolicy builds correct policy", () => {
  const policy = createSafetyPolicy("core", false);
  assert.ok(policy.allowedTools.has("mastercam_status"));
  assert.ok(policy.allowedTools.has("apply_operation_parameter_preview"));
  assert.ok(policy.requireApprovalFor.has("apply_operation_parameter_preview"));
});

test("checkToolAllowed respects dry run", () => {
  const policy = createSafetyPolicy("read", false);
  const result = checkToolAllowed(policy, "apply_operation_parameter_preview", true);
  assert.equal(result.allowed, true);
});

test("checkToolAllowed requires approval for writes", () => {
  const policy = createSafetyPolicy("core", false);
  const result = checkToolAllowed(policy, "apply_operation_parameter_preview", false);
  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, true);
});

test("checkToolAllowed blocks high risk tools", () => {
  const policy = createSafetyPolicy("dev", false);
  const result = checkToolAllowed(policy, "post_program", false);
  assert.equal(result.allowed, false);
});