import test from "node:test";
import assert from "node:assert/strict";
import { compareJson, compareNc, setupSheet, validateMachine } from "../src/shop.js";

test("setup sheets contain manufacturing context and approval state", () => {
  const sheet = setupSheet({ part: { number: "A1" }, operations: [{ id: 1 }], tools: [{ number: 4 }] });
  assert.equal(sheet.schema, "mastercam-mcp/setup-sheet/v1");
  assert.equal(sheet.review.requiresApproval, true);
  assert.equal(sheet.operations.length, 1);
});

test("NC comparison reports changed lines and tool changes", () => {
  const result = compareNc("T1\nG0 X0\n", "T2\nG0 X1\n");
  assert.equal(result.equal, false);
  assert.deepEqual(result.toolsBefore, [1]);
  assert.deepEqual(result.toolsAfter, [2]);
  assert.equal(result.changedLines, 2);
});

test("machine validation detects feed limit violations", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 50, controller: "Haas", holderFamily: "CAT40" });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, "FEED_EXCEEDS_MACHINE_LIMIT");
});

test("tool database comparison is deterministic", () => {
  const result = compareJson({ tools: [{ number: 1 }] }, { tools: [{ number: 2 }] });
  assert.equal(result.equal, false);
  assert.notEqual(result.leftHash, result.rightHash);
});
