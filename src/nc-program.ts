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

/** Parses only common, explicit G0/G1 motion. Unsupported motion stays an unknown. */
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
  let feed: number | undefined;
  let spindle: number | undefined;
  let feedPerMinute = true;
  let constantRpm = true;
  let cannedCycle = false;
  let hasWorkOffset = false;
  let pendingTool: number | undefined;

  const unknown = (line: number, code: string, message: string) => findings.push({ line, code, message });
const supportedG = new Set([0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 28, 30, 40, 41, 42, 43, 49, 53, 54, 55, 56, 57, 58, 59, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 94, 95, 96, 97]);

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
      if (whole === 20) programUnits = "inch";
      else if (whole === 21) programUnits = "mm";
      else if (whole === 90) absolute = true;
      else if (whole === 91) absolute = false;
      else if (whole === 94) feedPerMinute = true;
      else if (whole === 95) {
        feedPerMinute = false;
        unknown(lineNumber, "feed_per_revolution", "G95 feed-per-revolution motion needs spindle synchronization and is not timed or limit-checked");
      } else if (whole === 0) motion = "rapid";
      else if (whole === 1) motion = "feed";
      else if (whole === 2 || whole === 3) {
        motion = "arc";
        unknown(lineNumber, "arc_motion", "G2/G3 arc geometry is not expanded; full-arc clearance and cycle time remain unknown");
      }
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

    if ([17, 18, 19].some(code => gCodes.some(value => Math.trunc(value) === code))) {
      if (gCodes.some(value => [2, 3].includes(Math.trunc(value)))) unknown(lineNumber, "arc_plane", "Arc plane changes are not geometrically verified");
    }
    if (["A", "B", "C"].some(axis => parsed.has(axis))) unknown(lineNumber, "rotary_motion", "Rotary-axis motion is not kinematically transformed or checked");
    if (["I", "J", "K", "R"].some(axis => parsed.has(axis))) {
      if (gCodes.some(code => [2, 3].includes(Math.trunc(code)))) {
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
    if (!hasLinearAxis) continue;
    const start = { ...position };
    for (const axis of ["X", "Y", "Z"] as const) {
      const value = last(parsed, axis);
      if (value === undefined) continue;
      const scaled = value * scale;
      position[axis.toLowerCase() as "x" | "y" | "z"] = absolute ? scaled : position[axis.toLowerCase() as "x" | "y" | "z"] + scaled;
    }
    const end = { ...position };
    const cycleLine = gCodes.some(code => Math.trunc(code) >= 81 && Math.trunc(code) <= 89);
    if (motion === "arc" || cycleLine || cannedCycle || gCodes.some(code => [28, 30, 53].includes(Math.trunc(code)))) continue;
    if (!motion) {
      unknown(lineNumber, "motion_mode_unknown", "Axis words appear before an explicit or configured G0/G1 mode");
      continue;
    }
    if (motion === "feed" && (!feedPerMinute || feed === undefined)) {
      unknown(lineNumber, "feed_unknown", "Linear feed move has no known G94 feed rate");
      continue;
    }
    const id = `L${lineNumber}`;
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
    safetyMargin: input.safetyMargin,
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
    summary: { parsedLinearSegments: segments.length, sourceLines: input.program.split(/\r?\n/).length, blockers, warnings: risk?.summary.warnings ?? 0, unknown: allUnknowns },
    findings,
    risk,
    cycleTime,
    evidenceHash: sha256Of({ input, segments }),
    safety: "Partial static review of parsed G0/G1 moves only. Arcs, canned cycles, rotary kinematics, controller/post behavior, compensation, and physical simulation are not fully verified; this result never authorizes posting or machining."
  };
}
