import test from "node:test";
import assert from "node:assert/strict";
import { advertisedToolDefinitions } from "../src/mcp/create-server.js";

test("Stage-A live MCP discovery advertises only verified native surface", () => {
  const names = advertisedToolDefinitions("live").map(definition => definition.name).sort();
  assert.deepEqual(names, ["mastercam_capabilities", "mastercam_status"]);
});

test("fixture MCP discovery excludes deliberately unavailable mutations", () => {
  const names = new Set(advertisedToolDefinitions("mock").map(definition => definition.name));
  assert.equal(names.has("regenerate_toolpath"), false);
  assert.equal(names.has("change_tool"), false);
  assert.equal(names.has("update_stock"), false);
  assert.equal(names.has("apply_operation_parameter_preview"), true);
  assert.equal(names.has("rollback_change"), true);
});
