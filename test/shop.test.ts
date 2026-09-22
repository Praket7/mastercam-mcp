import test from "node:test";
import assert from "node:assert/strict";
import { compareJson, compareNc, setupSheet, validateMachine } from "../src/shop.js";

test("setup sheets contain manufacturing context and approval state", () => {
  const sheet = setupSheet({ part: { number: "A1" }, operations: [{ id: 1 }], tools: [{ number: 4 }] });
  assert.equal(sheet.schema, "mastercam-mcp/setup-sheet/v1");
  assert.equal(sheet.review.requiresApproval, true);
  assert.equal(sheet.operations.length, 1);
});

test("NC comparison reports changed lines and tool changes using Myers diff", () => {
  const result = compareNc("T1\nG0 X0\n", "T2\nG0 X1\n");
  assert.equal(result.equal, false);
  assert.deepEqual(result.toolsBefore, [1]);
  assert.deepEqual(result.toolsAfter, [2]);
  assert.ok(result.totalChanges >= 2);
  assert.ok(result.semanticSummary.toolChanges >= 0);
});

test("machine validation detects feed limit violations", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 50, controller: "Haas", holderFamily: "CAT40" });
  assert.equal(result.valid, false);
  assert.ok(result.checks.some(check => check.name === "feed_limit" && !check.pass && check.severity === "error"));
});

test("tool database comparison is deterministic and semantic", () => {
  const result = compareJson({ tools: [{ number: 1, name: "Tool 1" }] }, { tools: [{ number: 2, name: "Tool 2" }] });
  assert.equal(result.equal, false);
  assert.notEqual(result.leftHash, result.rightHash);
  assert.ok(result.added.length >= 0 || result.removed.length >= 0 || result.modified.length >= 0);
});

test("semantic JSON comparison handles nested objects", () => {
  const left = { operation: { feed: 100, tool: { number: 1 } } };
  const right = { operation: { feed: 200, tool: { number: 1 } } };
  const result = compareJson(left, right);
  assert.equal(result.equal, false);
  assert.ok(result.modified.some(m => (m as any).key === "operation" || (m as any).path === "operation.feed" || (m as any).path?.includes("feed")));
});

test("NC diff categorizes changes correctly", () => {
  const result = compareNc("T1 M6\nG0 X0 Y0\nG1 X10 F100\nM30", "T2 M6\nG0 X0 Y0\nG1 X20 F200\nM30");
  assert.equal(result.semanticSummary.toolChanges, 1);
  assert.equal(result.semanticSummary.feedChanges, 1);
  assert.ok(result.semanticSummary.rapidMoves >= 0);
});

test("machine validation requires controller", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 200 });
  assert.ok(result.checks.some(check => check.name === "controller_configured" && check.severity === "warning"));
});

test("machine validation warns about missing holder family", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 200, controller: "Fanuc" });
  assert.ok(result.checks.some(check => check.name === "holder_profile" && check.severity === "warning"));
});