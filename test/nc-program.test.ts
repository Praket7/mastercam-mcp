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

test("flags arcs, canned cycles, and work-offset travel uncertainty instead of declaring a clean path", () => {
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
  assert.ok(result.findings.some(item => item.code === "arc_motion"));
  assert.ok(result.findings.some(item => item.code === "canned_cycle"));
  assert.ok(result.findings.some(item => item.code === "work_coordinates"));
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
