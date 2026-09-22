import test from "node:test";
import assert from "node:assert/strict";
import { compareJson, compareNc, compareToolDatabases, setupSheet, validateMachine } from "../src/shop.js";

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
  assert.equal(result.semanticSummary.toolChanges, 1);
});

test("single-line replacement is a modification and is not falsely truncated", () => {
  const result = compareNc("G1 X10 F100\n", "G1 X20 F200\n", 200);
  assert.equal(result.modifiedLines, 1);
  assert.equal(result.displayedChanges, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.semanticSummary.feedChanges, 1);
});

test("unchanged modal semantics do not report phantom changes", () => {
  const result = compareNc(
    "G21 G90 G54\nT1 M6\nS8000 M3\nG0 X0\nG1 X10 F100\nM8\nG40 G49\nM9\n",
    "G21 G90 G54\nT1 M6\nS8000 M3\nG0 X1\nG1 X10 F100\nM8\nG40 G49\nM9\n"
  );
  assert.equal(result.semanticSummary.toolChanges, 0);
  assert.equal(result.semanticSummary.feedChanges, 0);
  assert.equal(result.semanticSummary.spindleChanges, 0);
  assert.equal(result.semanticSummary.workOffsetChanges, 0);
  assert.equal(result.semanticSummary.compensationChanges, 0);
  assert.equal(result.semanticSummary.coolantChanges, 0);
  assert.equal(result.semanticSummary.unitModeChanges, 0);
  assert.equal(result.semanticSummary.distanceModeChanges, 0);
});

test("NC semantic comparison detects safety-relevant modal changes", () => {
  const before = "G21 G90 G54\nG40 G49\nG0 G53 Z0\nM9\n";
  const after = "G20 G91 G55\nG41 G43\nG0 G28 Z0\nM8\n";
  const result = compareNc(before, after);
  assert.equal(result.semanticSummary.unitModeChanges, 1);
  assert.equal(result.semanticSummary.distanceModeChanges, 1);
  assert.equal(result.semanticSummary.workOffsetChanges, 1);
  assert.equal(result.semanticSummary.compensationChanges, 1);
  assert.equal(result.semanticSummary.toolLengthCompensationChanges, 1);
  assert.equal(result.semanticSummary.safeRetractChanges, 1);
  assert.equal(result.semanticSummary.coolantChanges, 1);
});

test("NC semantic parser ignores G-code-like text in comments", () => {
  const result = compareNc("(G20 F999 M8)\nG21 G90\nG1 X1 F100\n", "(G20 F1 M9)\nG21 G90\nG1 X2 F100\n");
  assert.equal(result.semantic.before.units, "mm");
  assert.equal(result.semantic.after.units, "mm");
  assert.deepEqual(result.semantic.before.feedValues, [100]);
  assert.deepEqual(result.semantic.after.feedValues, [100]);
  assert.equal(result.semanticSummary.feedChanges, 0);
  assert.equal(result.semanticSummary.coolantChanges, 0);
});

test("machine validation detects feed limit violations", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 50, controller: "Haas", holderFamily: "CAT40" });
  assert.equal(result.valid, false);
  assert.ok(result.checks.some(check => check.name === "feed_limit" && !check.pass && check.severity === "error"));
});

test("tool database comparison ignores harmless reordering", () => {
  const left = { tools: [{ number: 1, name: "Tool 1" }, { number: 2, name: "Tool 2" }] };
  const right = { tools: [{ number: 2, name: "Tool 2" }, { number: 1, name: "Tool 1" }] };
  const result = compareToolDatabases(left, right);
  assert.equal(result.equal, true);
  assert.ok("unchangedTools" in result);
  if ("unchangedTools" in result) assert.equal(result.unchangedTools, 2);
});

test("tool database comparison reports field-level changes for the same tool", () => {
  const result = compareToolDatabases(
    { tools: [{ number: 1, name: "Tool 1", diameter: 6 }] },
    { tools: [{ number: 1, name: "Tool 1", diameter: 8 }] }
  );
  assert.equal(result.equal, false);
  assert.ok("modifiedTools" in result);
  if ("modifiedTools" in result) {
    assert.equal(result.modifiedTools.length, 1);
    assert.ok(result.modifiedTools[0]?.fields?.some(field => field.path === "diameter"));
  }
});

test("semantic JSON comparison handles nested objects", () => {
  const left = { operation: { feed: 100, tool: { number: 1 } } };
  const right = { operation: { feed: 200, tool: { number: 1 } } };
  const result = compareJson(left, right);
  assert.equal(result.equal, false);
  assert.ok(result.modified.some(m => m.path === "operation.feed" || m.path.includes("feed")));
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
