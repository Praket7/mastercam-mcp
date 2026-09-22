import test from "node:test";
import assert from "node:assert/strict";
import {
  compareJson,
  compareNc,
  compareToolDatabases,
  setupSheet,
  summarizeNc,
  validateMachine
} from "../src/shop.js";

test("setup sheets contain manufacturing context and approval state", () => {
  const sheet = setupSheet({ part: { number: "A1" }, operations: [{ id: 1 }], tools: [{ number: 4 }] });
  assert.equal(sheet.schema, "mastercam-mcp/setup-sheet/v1");
  assert.equal(sheet.review.requiresApproval, true);
  assert.equal(sheet.operations.length, 1);
});

test("NC comparison reports replacement-aware changed lines and tool changes", () => {
  const result = compareNc("T1\nG0 X0\n", "T2\nG0 X1\n");
  assert.equal(result.equal, false);
  assert.deepEqual(result.toolsBefore, [1]);
  assert.deepEqual(result.toolsAfter, [2]);
  assert.equal(result.totalChanges, 2);
  assert.equal(result.modifiedLines, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.semanticSummary.toolChanges, 1);
});

test("single-line replacement is not falsely reported as truncated", () => {
  const result = compareNc("G1 X10 F100\n", "G1 X20 F100\n", 200);
  assert.equal(result.totalChangeCount, 1);
  assert.equal(result.displayedChangeCount, 1);
  assert.equal(result.modifiedLines, 1);
  assert.equal(result.truncated, false);
});

test("NC truncation is based on the complete paired change set", () => {
  const result = compareNc(
    "G1 X10 F100\nG1 X20 F100\nG1 X30 F100\n",
    "G1 X11 F110\nG1 X21 F120\nG1 X31 F130\n",
    1
  );
  assert.equal(result.totalChangeCount, 3);
  assert.equal(result.displayedChangeCount, 1);
  assert.equal(result.changes.length, 1);
  assert.equal(result.truncated, true);
});

test("NC semantic comparison measures actual modal and process changes", () => {
  const before = [
    "G21 G90 G17 G54",
    "T1 M6",
    "S5000 M3",
    "G43 H1",
    "M8",
    "G0 X0 Y0",
    "G1 X10 F100",
    "G28 Z0"
  ].join("\n");
  const after = [
    "G20 G91 G18 G55",
    "T2 M6",
    "S6000 M3",
    "G41 D1",
    "M9",
    "G0 X0 Y0",
    "G1 X10 F200",
    "G53 Z0"
  ].join("\n");
  const result = compareNc(before, after);

  assert.equal(result.semanticSummary.toolChanges, 1);
  assert.equal(result.semanticSummary.feedChanges, 1);
  assert.equal(result.semanticSummary.spindleChanges, 1);
  assert.equal(result.semanticSummary.workOffsetChanges, 1);
  assert.equal(result.semanticSummary.compensationChanges, 1);
  assert.equal(result.semanticSummary.coolantChanges, 1);
  assert.equal(result.semanticSummary.retractChanges, 1);
  assert.equal(result.semanticSummary.unitModeChanged, true);
  assert.equal(result.semanticSummary.positioningModeChanged, true);
  assert.equal(result.semanticSummary.planeChanged, true);
});

test("unchanged NC does not invent semantic changes", () => {
  const program = "G21 G90 G54\nT1 M6\nS5000 M3\nG1 X10 F100\nM8\nM9\n";
  const result = compareNc(program, program);
  assert.equal(result.equal, true);
  assert.equal(result.semanticSummary.toolChanges, 0);
  assert.equal(result.semanticSummary.feedChanges, 0);
  assert.equal(result.semanticSummary.spindleChanges, 0);
  assert.equal(result.semanticSummary.workOffsetChanges, 0);
  assert.equal(result.semanticSummary.compensationChanges, 0);
  assert.equal(result.semanticSummary.coolantChanges, 0);
});

test("NC semantic parser ignores comments and captures extended work offsets", () => {
  const summary = summarizeNc("(G20 T99 F999)\nG54.1 P12\n; M8\nG1 X1 F42\n");
  assert.equal(summary.units, undefined);
  assert.deepEqual(summary.toolChanges, []);
  assert.deepEqual(summary.feedValues, [42]);
  assert.ok(summary.workOffsets.includes("G54.1 P12"));
  assert.equal(summary.coolant.on, 0);
});

test("machine validation detects feed limit violations", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 50, controller: "Haas", holderFamily: "CAT40" });
  assert.equal(result.valid, false);
  assert.ok(result.checks.some(check => check.name === "feed_limit" && !check.pass && check.severity === "error"));
});

test("generic semantic JSON comparison handles nested objects", () => {
  const left = { operation: { feed: 100, tool: { number: 1 } } };
  const right = { operation: { feed: 200, tool: { number: 1 } } };
  const result = compareJson(left, right);
  assert.equal(result.equal, false);
  assert.ok(result.modified.some(entry => entry.path === "operation.feed"));
});

test("tool database comparison ignores collection ordering", () => {
  const left = {
    tools: [
      { number: 1, name: "EM .5", diameter: 12.7 },
      { number: 2, name: "DRILL", diameter: 6 }
    ]
  };
  const right = {
    tools: [
      { number: 2, name: "DRILL", diameter: 6 },
      { number: 1, name: "EM .5", diameter: 12.7 }
    ]
  };
  const result = compareToolDatabases(left, right);
  assert.equal(result.equal, true);
  assert.equal(result.orderingChanged, true);
  assert.equal(result.modified.length, 0);
});

test("tool database comparison reports field changes on a stable tool identity", () => {
  const left = { tools: [{ number: 1, name: "EM .5", diameter: 12.7 }] };
  const right = { tools: [{ number: 1, name: "EM .5", diameter: 12.5 }] };
  const result = compareToolDatabases(left, right);
  assert.equal(result.equal, false);
  assert.ok(result.modified.some(entry => entry.path.endsWith(".diameter")));
});

test("machine validation requires controller", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 200 });
  assert.ok(result.checks.some(check => check.name === "controller_configured" && check.severity === "warning"));
});

test("machine validation warns about missing holder family", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 200, controller: "Fanuc" });
  assert.ok(result.checks.some(check => check.name === "holder_profile" && check.severity === "warning"));
});
