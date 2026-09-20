import test from "node:test";
import assert from "node:assert/strict";
import { compareJson, compareNc, setupSheet, validateMachine, sequenceDiff } from "../src/shop.js";

test("setup sheets contain manufacturing context and approval state", () => {
  const sheet = setupSheet({ part: { number: "A1" }, operations: [{ id: 1 }], tools: [{ number: 4 }] });
  assert.equal(sheet.schema, "mastercam-mcp/setup-sheet/v1");
  assert.equal(sheet.review.requiresApproval, true);
  assert.equal(sheet.operations.length, 1);
});

test("NC comparison uses sequence diffing, not index alignment (BUG-14)", () => {
  const before = ["%", "O1000", "T1 M6", "G0 X0 Y0", "G1 Z-5 F100", "X10", "Y10", "M5", "M30"];
  const after = ["%", "O1000", "T1 M6", "G0 X0 Y0", "G1 Z-5 F100", "G4 P500", "X10", "Y10", "M5", "M30"];
  const result = compareNc(before.join("\n"), after.join("\n"));
  assert.equal(result.equal, false);
  // The inserted dwell line must not shift later comparisons into false positives.
  assert.equal(result.totalChangeCount, 1);
  assert.equal(result.addedLines, 1);
  assert.equal(result.removedLines, 0);
  assert.deepEqual(result.toolsBefore, [1]);
  assert.deepEqual(result.toolsAfter, [1]);
});

test("NC diff reports truncation honestly (BUG-14)", () => {
  const before = Array.from({ length: 400 }, (_, i) => `X${i}`).join("\n");
  const after = Array.from({ length: 400 }, (_, i) => `Y${i}`).join("\n");
  const result = compareNc(before, after, 50);
  assert.equal(result.totalChangeCount, 800);
  assert.equal(result.displayedChangeCount, 50);
  assert.equal(result.truncated, true);
});

test("sequence diff produces minimal edit script", () => {
  const ops = sequenceDiff(["a", "b", "c"], ["a", "x", "c"]);
  assert.equal(ops.filter(op => op.type === "equal").length, 2);
  assert.equal(ops.filter(op => op.type !== "equal").length, 2);
});

test("semantic NC summary extracts CNC concepts (section 36)", () => {
  const summary = compareNc("G21 G90\nT3 M6\nS8000 M3\nG0 X0\nG1 F500\nM8\nM1\n", "G20 G91\nT4 M6\nM9\n").semantic;
  assert.equal(summary.before.units, "mm");
  assert.equal(summary.before.absoluteMode, "absolute");
  assert.equal(summary.before.toolChanges[0], 3);
  assert.equal(summary.before.spindleChanges[0], 8000);
  assert.equal(summary.before.coolant.on, 1);
  assert.equal(summary.after.units, "inch");
  assert.equal(summary.after.absoluteMode, "incremental");
});

test("machine validation detects feed limit violations", () => {
  const result = validateMachine({ feed: 100 }, { maxFeed: 50, controller: "Haas", holderFamily: "CAT40" });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, "FEED_EXCEEDS_MACHINE_LIMIT");
});

test("machine validation never coerces empty strings to zero (section 37)", () => {
  const result = validateMachine({ feed: "" }, { maxFeed: 50, controller: "Haas", holderFamily: "CAT40" });
  assert.equal(result.issues.some(issue => issue.code === "FEED_UNKNOWN"), true);
  const asZero = validateMachine({ feed: "" }, { maxFeed: 50 });
  assert.equal(asZero.issues.some(issue => issue.code === "FEED_EXCEEDS_MACHINE_LIMIT"), false);
});

test("tool database comparison is semantic and key-order independent (BUG-13)", () => {
  const left = { tools: [{ number: 1, name: "EM" }], meta: { z: 1, a: 2 } };
  const right = { meta: { a: 2, z: 1 }, tools: [{ name: "EM", number: 1 }] };
  const result = compareJson(left, right);
  assert.equal(result.equal, true);
  const changed = compareJson({ tools: [{ number: 1 }] }, { tools: [{ number: 2 }] });
  assert.equal(changed.equal, false);
  assert.equal(changed.modified.length, 1);
  assert.equal(changed.modified[0].path, "tools.0.number");
});

test("inserted object properties do not shift subsequent lines (BUG-13)", () => {
  const left = { a: 1, b: 2, c: 3, d: 4 };
  const right = { a: 1, bNew: 9, b: 2, c: 3, d: 4 };
  const result = compareJson(left, right);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].path, "bNew");
  assert.equal(result.modified.length, 0);
});
