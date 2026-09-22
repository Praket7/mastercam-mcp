import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzePostRegression,
  analyzeRegenerationImpact,
  manufacturingPreflight
} from "../src/manufacturing-intelligence.js";

test("manufacturing preflight blocks dirty and unresolved-tool operations", () => {
  const result = manufacturingPreflight({
    part: { name: "bracket.mcam" },
    machine: { name: "VMC" },
    stock: { type: "block" },
    wcs: { name: "TOP" },
    post: { name: "approved.pst" },
    operations: [
      { id: 1, name: "Rough", tool: 7, feed: 1000, speed: 5000, toolpathDirty: true },
      { id: 2, name: "Finish", tool: 99, feed: 500, speed: 8000 }
    ],
    tools: [{ number: 7, name: "Endmill" }],
    verification: { simulationPassed: true, collisionCheckPassed: true, approvedPostBaselineAvailable: true }
  });

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.summary.blockers >= 2);
  assert.ok(result.checks.some(check => check.id === "dirty_toolpaths" && check.severity === "blocker"));
  assert.ok(result.checks.some(check => check.id === "tool_resolution" && check.severity === "blocker"));
  assert.match(result.safety, /does not prove machine safety/i);
});

test("manufacturing preflight never calls incomplete evidence safe", () => {
  const result = manufacturingPreflight({
    operations: [{ id: 1, feed: 100, speed: 1000 }],
    tools: []
  });
  assert.equal(result.status, "REVIEW");
  assert.ok(result.summary.unknown > 0);
  assert.ok(!JSON.stringify(result).includes('"SAFE"'));
});

test("regeneration impact walks transitive dependencies", () => {
  const result = analyzeRegenerationImpact({
    changedOperationIds: [1],
    operations: [
      { id: 1, name: "A", dependencies: [] },
      { id: 2, name: "B", dependencies: [1] },
      { id: 3, name: "C", dependencies: [2], toolpathDirty: true },
      { id: 4, name: "D", dependencies: [] }
    ]
  });

  assert.deepEqual(result.directlyDependentOperationIds, ["2"]);
  assert.deepEqual(result.transitivelyImpactedOperationIds.sort(), ["2", "3"]);
  assert.deepEqual(result.dirtyImpactedOperationIds, ["3"]);
  assert.equal(result.requiresReview, true);
});

test("regeneration impact reports unresolved graph evidence", () => {
  const result = analyzeRegenerationImpact({
    changedOperationIds: [1],
    operations: [{ id: 1, dependencies: [42] }]
  });
  assert.deepEqual(result.unresolvedDependencyIds, ["42"]);
  assert.equal(result.requiresReview, true);
});

test("post regression guardian escalates units and work-offset changes", () => {
  const result = analyzePostRegression({
    before: "G21 G90 G54\nT1 M6\nS5000 M3\nG0 X0 Y0\nF1000\nM30",
    after: "G20 G90 G55\nT1 M6\nS5000 M3\nG0 X0 Y0\nF1000\nM30",
    displayLimit: 50
  });
  assert.equal(result.risk, "CRITICAL");
  assert.equal(result.semanticSummary.unitModeChanged, true);
  assert.ok(result.semanticSummary.workOffsetChanges > 0);
  assert.equal(result.requiresHumanReview, true);
});

test("post regression guardian reports identical NC as no regression", () => {
  const nc = "G21 G90 G54\nT1 M6\nS5000 M3\nF1000\nM30";
  const result = analyzePostRegression({ before: nc, after: nc, displayLimit: 50 });
  assert.equal(result.risk, "NONE");
  assert.equal(result.requiresHumanReview, false);
});
