import test from "node:test";
import assert from "node:assert/strict";
import { allowed } from "../src/contracts.js";

test("read tools are always allowed", () => assert.equal(allowed("mastercam_status", "read", true), true));
test("hard read only blocks writes", () => assert.equal(allowed("apply_operation_parameter_preview", "write", true), false));
test("write profile allows writes", () => assert.equal(allowed("apply_operation_parameter_preview", "write", false), true));
test("posting is blocked by default", () => assert.equal(allowed("post_program", "all", false), false));
test("read profile blocks writes", () => assert.equal(allowed("apply_operation_parameter_preview", "read", false), false));
test("all profile allows advanced", () => assert.equal(allowed("run_simulation", "all", false), true));
test("unknown tool is not allowed", () => assert.equal(allowed("unknown_tool", "read", false), false));
