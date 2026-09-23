import test from "node:test";
import assert from "node:assert/strict";
import { analyzeNcProgram } from "../src/nc-program.js";

const machine = {
  travel: { min: { x: 0, y: 0, z: 0 }, max: { x: 200, y: 200, z: 200 } },
  rapidRate: 20000,
  maxFeedRate: 5000,
  maxSpindleRpm: 10000
};

test("parses modal G0/G1 moves, converts units, and flags overtravel and risky rapids", () => {
  const result = analyzeNcProgram({
    program: "G21 G90\nG0 X10 Y10 Z100\nG1 X50 F1200 S8000\nG0 X250 Y10 Z40",
    units: "mm",
    coordinateFrame: "machine",
    initialPosition: { x: 0, y: 0, z: 150 },
    machine,
    safeZ: 80
  });
  assert.equal(result.summary.parsedLinearSegments, 3);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.risk?.findings.some(item => item.id === "machine_overtravel"));
  assert.ok(result.risk?.findings.some(item => item.id === "rapid_below_safe_z"));
  assert.equal(result.cycleTime.unknownMoveCount, 1, "G1 engagement remains unknown instead of being guessed");
});

test("expands common arcs and still flags canned cycles and work-offset uncertainty", () => {
  const result = analyzeNcProgram({
    program: "G21 G90 G54\nG0 X10 Y10 Z100\nG2 X20 Y10 I5 J0\nG81 X20 Y10 Z-10 R2 F100",
    units: "mm",
    coordinateFrame: "work",
    initialPosition: { x: 0, y: 0, z: 100 },
    machine,
    safeZ: 80
  });
  assert.equal(result.machineTravelChecked, false);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.summary.parsedLinearSegments > 10, "G2 arc is chorded for conservative swept-path checks");
  assert.ok(result.findings.some(item => item.code === "canned_cycle"));
  assert.ok(result.findings.some(item => item.code === "work_coordinates"));
});

test("keeps modal arc direction and uses true arc length for cycle-time estimates", () => {
  const result = analyzeNcProgram({
    program: "G21 G90 G17\nG1 X10 Y0 F100\nG3 X0 Y10 I-10 J0\nX-10 Y0 I0 J-10",
    units: "mm",
    coordinateFrame: "machine",
    initialPosition: { x: 10, y: 0, z: 20 },
    machine
  });
  assert.ok(result.summary.parsedLinearSegments > 10);
  assert.equal(result.cycleTime.unknownMoveCount, 3, "cutting engagement remains unknown for each move");
  assert.ok(Math.abs(result.cycleTime.unknownEngagementSeconds - Math.PI * 10 / 100 * 60) < 1e-9);
  assert.ok(!result.findings.some(item => item.code === "arc_motion_unknown"));
  assert.ok(!result.findings.some(item => item.code === "arc_modal_direction_unknown"));
});

test("uses XZ/I-K ordering for G18 and fails closed on unexpanded arc modes", () => {
  const g18 = analyzeNcProgram({
    program: "G21 G90 G18\nG1 X12 Z4 F100\nG3 X2 Z14 I-10 K0",
    units: "mm",
    coordinateFrame: "machine",
    initialPosition: { x: 0, y: 0, z: 4 },
    machine
  });
  assert.equal(g18.summary.parsedPathSegments, 9);
  assert.ok(!g18.findings.some(item => item.code === "arc_motion_unknown"));

  const unsupported = analyzeNcProgram({
    program: "G21 G90 G17\nG1 X10 F100\nG91.1 G2 X0 Y10 I-10 P2 F100",
    units: "mm",
    coordinateFrame: "machine",
    initialPosition: { x: 10, y: 0, z: 20 },
    machine
  });
  assert.ok(unsupported.findings.some(item => item.code === "arc_turn_count_unknown"));
  assert.ok(unsupported.summary.unknown > 0);

  const partialAbsoluteCenter = analyzeNcProgram({
    program: "G21 G90 G17 G90.1\nG1 X10 Y0 F100\nG3 X0 Y10 I0 F100",
    units: "mm",
    coordinateFrame: "machine",
    initialPosition: { x: 10, y: 0, z: 20 },
    machine
  });
  assert.ok(partialAbsoluteCenter.findings.some(item => item.code === "arc_motion_unknown"));
});

test("requires explicit motion mode and keeps G95 feed timing unknown", () => {
  const result = analyzeNcProgram({
    program: "G21 G91\nX10 Y0 Z0\nG95 G1 X20 F0.2",
    units: "mm",
    coordinateFrame: "machine",
    initialPosition: { x: 0, y: 0, z: 50 },
    machine
  });
  assert.ok(result.findings.some(item => item.code === "motion_mode_unknown"));
  assert.ok(result.findings.some(item => item.code === "feed_per_revolution"));
  assert.ok(result.findings.some(item => item.code === "feed_unknown"));
});
