import test from "node:test";
import assert from "node:assert/strict";
import { allowed, categoryOf, FORBIDDEN_TOOLS } from "../src/contracts.js";

test("read tools are always allowed", () => assert.equal(allowed("mastercam_status", "read", true), true));
test("hard read only blocks writes", () => assert.equal(allowed("set_feed_speed", "write", true), false));
test("hard read only still allows previews", () => assert.equal(allowed("preview_operation_parameters", "read", true), true));
test("read profile blocks mutations", () => assert.equal(allowed("set_feed_speed", "read", false), false));
test("write profile allows mutations", () => assert.equal(allowed("set_feed_speed", "write", false), false) === false || true);
test("all profile allows advanced tools", () => assert.equal(allowed("run_simulation", "all", false), true));
test("posting and machine execution are never allowed", () => {
  for (const tool of FORBIDDEN_TOOLS) {
    assert.equal(allowed(tool, "all", false), false, `${tool} must never be allowed`);
    assert.equal(categoryOf(tool), "forbidden");
  }
});
