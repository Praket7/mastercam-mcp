import * as z from "zod/v4";
import { analyzeCycleTime, analyzeToolpathRisk, AnalyzeCycleTimeSchema, Bounds3Schema, Vector3Schema } from "./job-intelligence.js";
import { sha256Of } from "./audit/audit-log.js";

const Positive = z.number().finite().positive();
const Nonnegative = z.number().finite().nonnegative();

export const AnalyzeNcProgramSchema = z.object({
  program: z.string().min(1).max(1_000_000),
  units: z.enum(["mm", "inch"]),
  coordinateFrame: z.enum(["machine", "work"]),
  initialPosition: Vector3Schema,
  initialMotion: z.enum(["rapid", "feed"]).optional(),
  machine: z.object({
    travel: Bounds3Schema,
    rapidRate: Positive,
    maxFeedRate: Positive.optional(),
    maxSpindleRpm: Positive.optional()
  }).strict(),
  stock: Bounds3Schema.optional(),
  fixtures: z.array(z.object({ id: z.string().min(1).max(128), bounds: Bounds3Schema }).strict()).max(100).default([]),
  safeZ: z.number().finite().optional(),
  toolRadius: Nonnegative.default(0),
  holderRadius: Nonnegative.default(0),
  safetyMargin: Nonnegative.default(0),
  defaultToolChangeSeconds: Nonnegative.default(8),
  arcChordError: Positive.optional(),
  maxArcSegments: z.number().int().min(8).max(10000).default(2048),
  dwellPMilliseconds: z.boolean().default(false)
}).strict();

type Input = z.infer<typeof AnalyzeNcProgramSchema>;
type Vec = z.infer<typeof Vector3Schema>;
type Segment = {
  id: string;
  motion: "rapid" | "feed";
  start: Vec;
  end: Vec;
  feedRate?: number;
  spindleRpm?: number;
  engagement: "unknown";
  toolRadius: number;
  holderRadius: number;
};

type ArcPlane = "G17" | "G18" | "G19";

function arcAxes(plane: ArcPlane): { u: "x" | "y" | "z"; v: "x" | "y" | "z"; w: "x" | "y" | "z"; a: "I" | "J" | "K"; b: "I" | "J" | "K" } {
  if (plane === "G18") return { u: "x", v: "z", w: "y", a: "I", b: "K" };
  if (plane === "G19") return { u: "y", v: "z", w: "x", a: "J", b: "K" };
  return { u: "x", v: "y", w: "z", a: "I", b: "J" };
}

function directedSweep(start: number, end: number, clockwise: boolean): number {
  let sweep = end - start;
  if (clockwise) {
    while (sweep >= 0) sweep -= Math.PI * 2;
  } else {
    while (sweep <= 0) sweep += Math.PI * 2;
  }
  return sweep;
}

function buildArc(input: {
  start: Vec; end: Vec; plane: ArcPlane; clockwise: boolean;
  centerU?: number; centerV?: number; radiusWord?: number;
  absoluteCenter: boolean; units: "mm" | "inch"; error: number; maxSegments: number;
}) : { points: Vec[]; length: number } | undefined {
  const { u, v, w } = arcAxes(input.plane);
  const startU = input.start[u], startV = input.start[v];
  const endU = input.end[u], endV = input.end[v];
  const du = endU - startU, dv = endV - startV;
  const chord = Math.hypot(du, dv);
  let centerU: number, centerV: number;

  if (input.radiusWord !== undefined) {
    const radius = Math.abs(input.radiusWord);
    if (chord <= 1e-12 || chord > 2 * radius) return undefined;
    const height = Math.sqrt(Math.max(0, radius * radius - chord * chord / 4));
    const midU = (startU + endU) / 2, midV = (startV + endV) / 2;
    const perpU = -dv / chord, perpV = du / chord;
    const candidates = [
      [midU + perpU * height, midV + perpV * height],
      [midU - perpU * height, midV - perpV * height]
    ];
    const sweepFor = ([cu, cv]: number[]) => directedSweep(Math.atan2(startV - cv!, startU - cu!), Math.atan2(endV - cv!, endU - cu!), input.clockwise);
    const wantMajor = input.radiusWord < 0;
    const selected = candidates.find(center => Math.abs(sweepFor(center)) > Math.PI + 1e-9 === wantMajor) ?? candidates[0]!;
    [centerU, centerV] = selected as [number, number];
  } else if (input.centerU !== undefined || input.centerV !== undefined) {
    if (input.absoluteCenter && (input.centerU === undefined || input.centerV === undefined)) return undefined;
    centerU = input.absoluteCenter ? input.centerU ?? startU : startU + (input.centerU ?? 0);
    centerV = input.absoluteCenter ? input.centerV ?? startV : startV + (input.centerV ?? 0);
  } else return undefined;

  const radius = Math.hypot(startU - centerU, startV - centerV);
  if (!(radius > 0)) return undefined;
  const endRadius = Math.hypot(endU - centerU, endV - centerV);
  const tolerance = input.units === "mm" ? 0.01 : 0.0005;
  if (Math.abs(radius - endRadius) > Math.max(tolerance, radius * 1e-4)) return undefined;
  const startAngle = Math.atan2(startV - centerV, startU - centerU);
  const endAngle = Math.atan2(endV - centerV, endU - centerU);
  const fullCircle = chord <= tolerance && (input.centerU !== undefined || input.centerV !== undefined);
  const sweep = fullCircle ? (input.clockwise ? -2 * Math.PI : 2 * Math.PI) : directedSweep(startAngle, endAngle, input.clockwise);
  const maxAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - input.error / radius)));
  if (!(maxAngle > 0)) return undefined;
  const count = Math.ceil(Math.abs(sweep) / Math.min(maxAngle, Math.PI / 2));
  if (count < 1 || count > input.maxSegments) return undefined;

  const points: Vec[] = [input.start];
  for (let i = 1; i <= count; i++) {
    const ratio = i / count;
    const angle = startAngle + sweep * ratio;
    const point = { ...input.start };
    point[u] = i === count ? endU : centerU + radius * Math.cos(angle);
    point[v] = i === count ? endV : centerV + radius * Math.sin(angle);
    point[w] = input.start[w] + (input.end[w] - input.start[w]) * ratio;
    points.push(point);
  }
  return { points, length: Math.hypot(radius * sweep, input.end[w] - input.start[w]) };
}

function stripComments(line: string): string {
  return line.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").trim();
}

function words(line: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const match of line.matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gi)) {
    const letter = match[1]!.toUpperCase();
    const values = result.get(letter) ?? [];
    values.push(Number(match[2]));
    result.set(letter, values);
  }
  return result;
}

function last(values: Map<string, number[]>, key: string): number | undefined {
  return values.get(key)?.at(-1);
}

function unitFactor(programUnits: "mm" | "inch", analysisUnits: "mm" | "inch"): number {
  if (programUnits === analysisUnits) return 1;
  return programUnits === "inch" ? 25.4 : 1 / 25.4;
}

/** Parses common G0/G1/G2/G3 motion. Unsupported controller features stay unknown. */
export function analyzeNcProgram(input: Input) {
  input = AnalyzeNcProgramSchema.parse(input);
  if (input.program.split(/\r?\n/).length > 50_000) throw new Error("NC program exceeds the 50,000-line analysis limit");

  const findings: Array<{ line: number; code: string; message: string }> = [];
  const segments: Segment[] = [];
  const events: Array<z.infer<typeof AnalyzeCycleTimeSchema>["events"][number]> = [];
  const position = { ...input.initialPosition };
  let programUnits = input.units;
  let absolute = true;
  let motion: "rapid" | "feed" | "arc" | undefined = input.initialMotion;
  let arcClockwise: boolean | undefined;
  let feed: number | undefined;
  let spindle: number | undefined;
  let feedPerMinute = true;
  let constantRpm = true;
  let arcPlane: ArcPlane = "G17";
  let arcCenterAbsolute = false;
  let cannedCycle = false;
  let hasWorkOffset = false;
  let hasExpandedArc = false;
  let pendingTool: number | undefined;
  const arcTolerance = input.arcChordError ?? (input.units === "mm" ? 0.05 : 0.002);

  const unknown = (line: number, code: string, message: string) => findings.push({ line, code, message });
const supportedG = new Set([0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 28, 30, 40, 41, 42, 43, 49, 53, 54, 55, 56, 57, 58, 59, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 90.1, 91, 91.1, 94, 95, 96, 97]);

  for (const [index, raw] of input.program.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const text = stripComments(raw).replace(/^\s*%\s*$/, "");
    if (!text) continue;
    if (/[#=\x5B\x5D]/.test(text)) unknown(lineNumber, "macro_or_expression", "Macro/expression syntax is not evaluated; affected motion is not verified");

    const parsed = words(text);
    const gCodes = parsed.get("G") ?? [];
    const mCodes = parsed.get("M") ?? [];
    const unsupportedG = gCodes.filter(code => !supportedG.has(code));
    if (unsupportedG.length > 0) unknown(lineNumber, "unsupported_g_code", `Unsupported G code(s): ${unsupportedG.join(", ")}`);
    if (mCodes.some(code => [97, 98, 99, 198].includes(Math.trunc(code)))) {
      unknown(lineNumber, "subprogram_flow", "Subprogram/call/return flow is not expanded; downstream positions may be incomplete");
    }

    for (const code of gCodes) {
      const whole = Math.trunc(code);
      if (code === 90.1) arcCenterAbsolute = true;
      else if (code === 91.1) arcCenterAbsolute = false;
      else if (whole === 17 || whole === 18 || whole === 19) arcPlane = `G${whole}` as ArcPlane;
      else if (whole === 20) programUnits = "inch";
      else if (whole === 21) programUnits = "mm";
      else if (whole === 90) absolute = true;
      else if (whole === 91) absolute = false;
      else if (whole === 94) feedPerMinute = true;
      else if (whole === 95) {
        feedPerMinute = false;
        unknown(lineNumber, "feed_per_revolution", "G95 feed-per-revolution motion needs spindle synchronization and is not timed or limit-checked");
      } else if (whole === 0) motion = "rapid";
      else if (whole === 1) motion = "feed";
      else if (code === 2 || code === 3) { motion = "arc"; arcClockwise = code === 2; }
      else if (whole >= 81 && whole <= 89) {
        cannedCycle = true;
        unknown(lineNumber, "canned_cycle", `G${whole} canned-cycle motion is not expanded`);
      } else if (whole === 80) cannedCycle = false;
      else if ([28, 30, 53].includes(whole)) unknown(lineNumber, "machine_reference_motion", `G${whole} machine/reference motion is not expanded`);
      else if ([41, 42, 43, 49].includes(whole)) unknown(lineNumber, "compensation", `G${whole} compensation may change the physical path and is not modeled`);
      else if (whole >= 54 && whole <= 59) hasWorkOffset = true;
      else if (whole === 96) {
        constantRpm = false;
        unknown(lineNumber, "constant_surface_speed", "G96 constant-surface-speed mode is not converted to axis RPM");
      } else if (whole === 97) constantRpm = true;
    }

    if (["A", "B", "C"].some(axis => parsed.has(axis))) unknown(lineNumber, "rotary_motion", "Rotary-axis motion is not kinematically transformed or checked");
    if (["U", "V", "W"].some(axis => parsed.has(axis))) unknown(lineNumber, "secondary_axis_motion", "Secondary-axis motion (U/V/W) is controller-specific and is not transformed");
    if (["I", "J", "K", "R"].some(axis => parsed.has(axis))) {
      if (motion === "arc") {
        // Arc lines are intentionally kept out of the linear segment list.
      } else {
        unknown(lineNumber, "arc_words_without_arc", "Arc-center/radius words without a parsed arc are not interpreted");
      }
    }

    const scale = unitFactor(programUnits, input.units);
    const f = last(parsed, "F");
    if (f !== undefined) feed = f * scale;
    const s = last(parsed, "S");
    if (s !== undefined) spindle = s;
    const t = last(parsed, "T");
    if (t !== undefined) pendingTool = t;
    if (mCodes.some(code => Math.trunc(code) === 6)) {
      events.push({ id: `tool-change-L${lineNumber}`, kind: "tool_change", ...(pendingTool === undefined ? {} : { operationId: pendingTool }), seconds: input.defaultToolChangeSeconds });
      pendingTool = undefined;
    }
    if (gCodes.some(code => Math.trunc(code) === 4)) {
      const p = last(parsed, "P");
      if (p !== undefined && input.dwellPMilliseconds) events.push({ id: `dwell-L${lineNumber}`, kind: "dwell", seconds: p / 1000 });
      else unknown(lineNumber, "dwell_units", "G4 dwell is not counted because this controller's P/X time units are unspecified");
    }

    const hasLinearAxis = ["X", "Y", "Z"].some(axis => parsed.has(axis));
    const hasArcCenter = ["I", "J", "K", "R"].some(axis => parsed.has(axis));
    if (!hasLinearAxis && !(motion === "arc" && hasArcCenter)) continue;
    const start = { ...position };
    for (const axis of ["X", "Y", "Z"] as const) {
      const value = last(parsed, axis);
      if (value === undefined) continue;
      const scaled = value * scale;
      position[axis.toLowerCase() as "x" | "y" | "z"] = absolute ? scaled : position[axis.toLowerCase() as "x" | "y" | "z"] + scaled;
    }
    const end = { ...position };
    const cycleLine = gCodes.some(code => Math.trunc(code) >= 81 && Math.trunc(code) <= 89);
    if (cycleLine || cannedCycle || gCodes.some(code => [28, 30, 53].includes(Math.trunc(code)))) continue;
    if (!motion) {
      unknown(lineNumber, "motion_mode_unknown", "Axis words appear before an explicit or configured G0/G1 mode");
      continue;
    }
    if (motion === "feed" && (!feedPerMinute || feed === undefined)) {
      unknown(lineNumber, "feed_unknown", "Linear feed move has no known G94 feed rate");
      continue;
    }
    const id = `L${lineNumber}`;
    if (motion === "arc") {
      if (parsed.has("P")) {
        unknown(lineNumber, "arc_turn_count_unknown", "Arc P-word turn counts are controller-specific and are not expanded");
        continue;
      }
      const scaleFactor = unitFactor(programUnits, input.units);
      const centerWord = (key: "I" | "J" | "K") => last(parsed, key) === undefined ? undefined : last(parsed, key)! * scaleFactor;
      const rWord = last(parsed, "R");
      if (rWord !== undefined && (centerWord(arcAxes(arcPlane).a) !== undefined || centerWord(arcAxes(arcPlane).b) !== undefined)) {
        unknown(lineNumber, "arc_format_conflict", "Arc radius and center-offset formats are both present; controller precedence is unknown");
        continue;
      }
      const arc = buildArc({
        start,
        end,
        plane: arcPlane,
        clockwise: arcClockwise ?? false,
        centerU: centerWord(arcAxes(arcPlane).a),
        centerV: centerWord(arcAxes(arcPlane).b),
        radiusWord: rWord === undefined ? undefined : rWord * scaleFactor,
        absoluteCenter: arcCenterAbsolute,
        units: input.units,
        error: arcTolerance,
        maxSegments: input.maxArcSegments
      });
      if (arcClockwise === undefined) {
        unknown(lineNumber, "arc_modal_direction_unknown", "Arc direction is unknown until an explicit G2/G3 is seen");
        continue;
      }
      if (!arc) {
        unknown(lineNumber, "arc_motion_unknown", "Arc center/radius is absent, inconsistent, or exceeds the segment limit");
        continue;
      }
      if (segments.length + arc.points.length - 1 > 10_000) {
        unknown(lineNumber, "segment_limit", "Expanded NC motion exceeds the 10,000-segment safety-analysis limit");
        continue;
      }
      hasExpandedArc = true;
      for (let i = 1; i < arc.points.length; i++) segments.push({
        id: `${id}.${i}`,
        motion: "feed",
        start: arc.points[i - 1]!,
        end: arc.points[i]!,
        feedRate: feed,
        ...(spindle !== undefined && constantRpm ? { spindleRpm: spindle } : {}),
        engagement: "unknown",
        toolRadius: input.toolRadius,
        holderRadius: input.holderRadius
      });
      events.push({ id, kind: "move", motion: "feed", start, end, pathLength: arc.length, ...(feedPerMinute && feed !== undefined ? { feedRate: feed } : {}) });
      continue;
    }
    const segment: Segment = {
      id,
      motion,
      start,
      end,
      ...(motion === "feed" && feed !== undefined ? { feedRate: feed } : {}),
      ...(spindle !== undefined && constantRpm ? { spindleRpm: spindle } : {}),
      engagement: "unknown",
      toolRadius: input.toolRadius,
      holderRadius: input.holderRadius
    };
    segments.push(segment);
    events.push({
      id,
      kind: "move",
      motion,
      start,
      end,
      ...(segment.feedRate !== undefined ? { feedRate: segment.feedRate } : {})
    });
  }

  const broadBounds = {
    min: { x: -1e12, y: -1e12, z: -1e12 },
    max: { x: 1e12, y: 1e12, z: 1e12 }
  };
  const travelVerified = input.coordinateFrame === "machine" && !hasWorkOffset;
  const risk = segments.length > 0 ? analyzeToolpathRisk({
    segments,
    machine: {
      travel: travelVerified ? input.machine.travel : broadBounds,
      maxFeedRate: input.machine.maxFeedRate,
      maxSpindleRpm: input.machine.maxSpindleRpm
    },
    stock: input.stock,
    fixtures: input.fixtures,
    safetyMargin: input.safetyMargin + (hasExpandedArc ? arcTolerance : 0),
    safeZ: input.safeZ
  }) : undefined;
  if (!travelVerified) unknown(0, input.coordinateFrame === "work" ? "work_coordinates" : "work_offset", "Machine travel checks are skipped because NC positions use a work offset and no WCS-to-machine transform was supplied");
  const cycleTime = analyzeCycleTime({
    events,
    machineRapidRate: input.machine.rapidRate,
    defaultToolChangeSeconds: input.defaultToolChangeSeconds,
    opportunityThresholdSeconds: 1
  });
  const riskFindings = risk?.findings ?? [];
  const allUnknowns = findings.length + riskFindings.filter(item => item.severity === "unknown").length + cycleTime.unknownMoveCount;
  const blockers = riskFindings.filter(item => item.severity === "blocker").length;
  return {
    schema: "mastercam-mcp/nc-program-analysis/v1",
    status: blockers > 0 ? "BLOCKED" : allUnknowns > 0 || risk?.status === "REVIEW" ? "REVIEW" : "NO_RISK_FOUND_IN_PARSED_MOTION",
    coordinateFrame: input.coordinateFrame,
    machineTravelChecked: travelVerified,
    units: input.units,
    summary: { parsedPathSegments: segments.length, parsedLinearSegments: segments.length, sourceLines: input.program.split(/\r?\n/).length, blockers, warnings: risk?.summary.warnings ?? 0, unknown: allUnknowns },
    findings,
    risk,
    cycleTime,
    evidenceHash: sha256Of({ input, segments }),
    safety: "Partial static review of linear and bounded G2/G3 arc motion. Canned cycles, macros, subprograms, rotary kinematics, work-offset transforms, controller/post behavior, compensation, and physical simulation remain unverified; this result never authorizes posting or machining."
  };
}
