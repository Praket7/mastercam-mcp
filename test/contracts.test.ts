import test from "node:test";
import assert from "node:assert/strict";
import { allowed } from "../src/contracts.js";
test("read tools are always allowed", () => assert.equal(allowed("mastercam_status", "read", true, false), true));
test("hard read only blocks writes", () => assert.equal(allowed("set_feed_speed", "core", true, false), false));
test("write profile allows dry run", () => assert.equal(allowed("set_feed_speed", "core", false, true), true));
test("posting is blocked by default", () => assert.equal(allowed("post_program", "dev", false, false), false));
