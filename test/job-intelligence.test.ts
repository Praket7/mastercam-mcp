import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCycleTime,
  analyzeToolpathRisk,
  calculateThreadTap,
  generateOperationPacket,
  planOdRoughFinish,
  recommendJobTooling
} from "../src/job-intelligence.js";
import { SERVER_LOCAL_TOOL_NAMES } from "../src/execution-surface.js";
import { manifestEntry } from "../src/tool-manifest.js";

test("tooling recommendation is grounded in supplied library compatibility", () => {
  const result = recommendJobTooling({
    material: "4140 steel",
    features: [
      { id: "bore", type: "boring", diameter: 20, depth: 25, internal: true }
    ],
    tools: [
      {
        number: 1,
        name: "20 mm boring bar",
        type: "boring bar",
        diameter: 16,
        maxDepth: 40,
        materials: ["4140 steel"],
        operations: ["boring"],
        insert: "CCMT",
        grade: "P25",
        provenance: [{ source: "shop library", verified: true }]
      },
      {
        number: 2,
        name: "oversize bar",
        diameter: 25,
        materials: ["4140 steel"],
        operations: ["boring"]
      },
      {
        number: 3,
        name: "aluminum bar",
        diameter: 12,
        materials: ["aluminum"],
        operations: ["boring"]
      }
    ],
    topK: 3
  });

  const feature = result.features[0]!;
  assert.equal(feature.status, "RECOMMENDATIONS_AVAILABLE");
  assert.equal(feature.recommendations[0]?.toolNumber, 1);
  assert.ok(feature.rejected.some(item => item.toolNumber === 2 &&
    item.hardRejectReasons.some(reason => reason.includes("diameter"))));
  assert.ok(feature.rejected.some(item => item.toolNumber === 3 &&
    item.hardRejectReasons.some(reason => reason.includes("material"))));
});

test("toolpath risk finds overtravel, fixture envelope, and low rapid motion", () => {
  const result = analyzeToolpathRisk({
    machine: {
      travel: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 500, y: 500, z: 500 }
      },
      maxFeedRate: 5000,
      maxSpindleRpm: 10000
    },
    stock: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 100, y: 100, z: 50 }
    },
    fixtures: [{
      id: "vise",
      bounds: {
        min: { x: 90, y: 90, z: 0 },
        max: { x: 140, y: 140, z: 80 }
      }
    }],
    safetyMargin: 2,
    safeZ: 100,
    segments: [
      {
        id: "rapid-1",
        motion: "rapid",
        start: { x: 10, y: 10, z: 80 },
        end: { x: 120, y: 120, z: 40 },
        engagement: "air",
        toolRadius: 5,
        holderRadius: 15
      },
      {
        id: "feed-1",
        motion: "feed",
        start: { x: 490, y: 10, z: 20 },
        end: { x: 510, y: 10, z: 20 },
        feedRate: 6000,
        spindleRpm: 12000,
        engagement: "cut",
        toolRadius: 2,
        holderRadius: 5
      }
    ]
  });

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some(item => item.id === "machine_overtravel"));
  assert.ok(result.findings.some(item => item.id === "fixture_swept_envelope"));
  assert.ok(result.findings.some(item => item.id === "rapid_below_safe_z"));
  assert.ok(result.findings.some(item => item.id === "feed_limit"));
  assert.ok(result.findings.some(item => item.id === "spindle_limit"));
});

test("toolpath approach-angle check is explicit and threshold based", () => {
  const result = analyzeToolpathRisk({
    machine: {
      travel: {
        min: { x: -100, y: -100, z: -100 },
        max: { x: 100, y: 100, z: 100 }
      }
    },
    fixtures: [],
    safetyMargin: 0,
    maxApproachAngleDeg: 10,
    segments: [{
      id: "angled",
      motion: "feed",
      start: { x: 0, y: 0, z: 10 },
      end: { x: 0, y: 0, z: 0 },
      engagement: "cut",
      toolRadius: 1,
      holderRadius: 1,
      toolAxis: { x: 0.5, y: 0, z: -0.8660254 },
      surfaceNormal: { x: 0, y: 0, z: 1 }
    }]
  });
  const finding = result.findings.find(item => item.id === "approach_angle");
  assert.ok(finding);
  assert.equal(finding.severity, "warning");
});

test("cycle time analysis reconciles cutting and non-cutting components", () => {
  const result = analyzeCycleTime({
    machineRapidRate: 6000,
    defaultToolChangeSeconds: 5,
    opportunityThresholdSeconds: 1,
    events: [
      {
        id: "r1",
        kind: "move",
        motion: "rapid",
        start: { x: 0, y: 0, z: 0 },
        end: { x: 100, y: 0, z: 0 },
        engaged: false
      },
      {
        id: "c1",
        kind: "move",
        motion: "feed",
        start: { x: 0, y: 0, z: 0 },
        end: { x: 60, y: 0, z: 0 },
        feedRate: 600,
        engaged: true
      },
      {
        id: "a1",
        kind: "move",
        motion: "feed",
        start: { x: 0, y: 0, z: 0 },
        end: { x: 30, y: 0, z: 0 },
        feedRate: 300,
        engaged: false
      },
      { id: "d1", kind: "dwell", seconds: 2 },
      { id: "t1", kind: "tool_change" }
    ]
  });

  assert.equal(result.breakdown.rapidSeconds, 1);
  assert.equal(result.breakdown.cuttingSeconds, 6);
  assert.equal(result.breakdown.airFeedSeconds, 6);
  assert.equal(result.breakdown.dwellSeconds, 2);
  assert.equal(result.breakdown.toolChangeSeconds, 5);
  assert.equal(result.knownSeconds, 20);
  assert.equal(result.breakdown.nonCuttingSeconds, 14);
  assert.ok(result.opportunities.some(item => item.kind === "air_feed"));
});

test("operation packet is derived from the supplied tree and flags unresolved tools", () => {
  const result = generateOperationPacket({
    part: { name: "shaft.mcam" },
    machine: { name: "Lathe A" },
    stock: { description: "2 inch bar" },
    wcs: { name: "G54" },
    tools: [{
      number: 1,
      name: "OD rougher",
      holderStyle: "ER32",
      machineLocation: "Turret 2 / pocket 4",
      lengthOutOfHolder: { value: 38, unit: "mm" },
      operations: ["turning rough"],
      materials: ["steel"],
      provenance: [{ source: "shop library" }]
    }],
    operations: [
      {
        id: 10,
        name: "OD Rough",
        type: "turning rough",
        toolNumber: 1,
        wcs: "G54",
        feedRate: 0.25,
        spindleRpm: 1200,
        estimatedCycleSeconds: 45
      },
      {
        id: 20,
        name: "OD Finish",
        type: "turning finish",
        toolNumber: 7,
        toolpathDirty: true,
        estimatedCycleSeconds: 15
      }
    ],
    notes: ["Verify jaw clearance"],
    setupReferences: [{ label: "Setup view", reference: "job-42/op1-view.png" }]
  });

  assert.match(result.markdown, /OD Rough/);
  assert.match(result.markdown, /Verify jaw clearance/);
  assert.match(result.markdown, /length out of holder/i);
  assert.match(result.markdown, /ER32/);
  assert.match(result.markdown, /op1-view.png/);
  assert.equal(result.summary.estimatedCycleSeconds, 60);
  assert.deepEqual(result.summary.dirtyOperationIds, [20]);
  assert.deepEqual(result.summary.unresolvedTools, [{ operationId: 20, toolNumber: 7 }]);
});

test("metric thread callout produces cut-tap drill and synchronized feed", () => {
  const result = calculateThreadTap({
    system: "metric",
    geometry: { callout: "M10x1.5" },
    threadPercent: 75,
    tapType: "cut",
    cuttingSpeed: 30
  });

  assert.equal(result.status, "CALCULATED");
  if (result.status !== "CALCULATED") return;
  assert.ok(Math.abs(result.resolved.nominalDiameter - 10) < 1e-9);
  assert.ok(Math.abs(result.resolved.pitch - 1.5) < 1e-9);
  assert.ok(result.geometry.tapDrill !== undefined);
  assert.ok(Math.abs(result.geometry.tapDrill! - 8.538) < 0.01);
  assert.ok(result.cutting.rpm !== undefined && result.cutting.rpm > 900);
  assert.ok(result.cutting.feedRate !== undefined && result.cutting.feedRate > 1300);
});

test("unified thread callout parses fractional diameter and TPI", () => {
  const result = calculateThreadTap({
    system: "unified",
    geometry: { callout: "1/4-20 UNC" },
    threadPercent: 75,
    tapType: "cut",
    rpm: 1000
  });

  assert.equal(result.status, "CALCULATED");
  if (result.status !== "CALCULATED") return;
  assert.ok(Math.abs(result.resolved.nominalDiameter - 0.25) < 1e-9);
  assert.ok(Math.abs(result.resolved.pitch - 0.05) < 1e-9);
  assert.ok(Math.abs((result.geometry.tapDrill ?? 0) - 0.2013) < 0.001);
  assert.ok(Math.abs((result.cutting.feedRate ?? 0) - 50) < 1e-9);
});

test("form-tap calculation refuses to invent a generic drill recommendation", () => {
  const result = calculateThreadTap({
    system: "metric",
    geometry: { nominalDiameter: 8, pitch: 1.25 },
    threadPercent: 75,
    tapType: "form"
  });
  assert.equal(result.status, "CALCULATED");
  if (result.status !== "CALCULATED") return;
  assert.equal(result.geometry.tapDrill, undefined);
  assert.ok(result.warnings.some(item => item.includes("manufacturer")));
});

test("OD rough plus finish plan remains non-executable and uses supplied tool data", () => {
  const result = planOdRoughFinish({
    intent: "make me a rough + finish toolpath for this OD profile",
    units: "mm",
    material: "4140 steel",
    stockDiameter: 50,
    profile: [
      { z: 0, diameter: 45 },
      { z: -50, diameter: 40 }
    ],
    finishAllowanceRadial: 0.2,
    tools: [
      {
        number: 1,
        name: "CNMG rougher",
        operations: ["turning rough"],
        materials: ["4140 steel"],
        recommended: { radialDepth: 1, surfaceSpeed: 180 },
        provenance: [{ source: "shop library", verified: true }]
      },
      {
        number: 2,
        name: "VNMG finisher",
        operations: ["turning finish"],
        materials: ["4140 steel"],
        recommended: { surfaceSpeed: 220 },
        provenance: [{ source: "shop library", verified: true }]
      }
    ],
    machine: { maxRpm: 3000 }
  });

  assert.equal(result.status, "PLAN_READY_FOR_REVIEW");
  assert.equal(result.executable, false);
  assert.equal(result.plan.roughPassCount, 5);
  assert.equal(result.toolSelection.rough?.toolNumber, 1);
  assert.equal(result.toolSelection.finish?.toolNumber, 2);
  assert.ok(result.verificationRequired.some(item => item.includes("collision simulation")));
});

test("OD plan blocks when shop tooling cannot support finish operation", () => {
  const result = planOdRoughFinish({
    intent: "rough and finish",
    units: "mm",
    material: "steel",
    stockDiameter: 50,
    profile: [{ z: 0, diameter: 45 }, { z: -10, diameter: 40 }],
    finishAllowanceRadial: 0.2,
    roughDepthRadial: 1,
    tools: [{
      number: 1,
      name: "rougher",
      operations: ["turning rough"],
      materials: ["steel"]
    }]
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.some(item => item.includes("finish-turning")));
});

test("new intelligence tools are server-local and registered", () => {
  for (const name of [
    "recommend_job_tooling",
    "analyze_toolpath_risk",
    "analyze_cycle_time",
    "generate_operation_packet",
    "calculate_thread_tap",
    "plan_od_rough_finish"
  ]) {
    assert.equal(SERVER_LOCAL_TOOL_NAMES.has(name), true);
    assert.equal(manifestEntry(name)?.registered, true);
  }
  assert.equal(manifestEntry("plan_od_rough_finish")?.category, "preview");
});
