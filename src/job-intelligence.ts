import * as z from "zod/v4";
import { sha256Of } from "./audit/audit-log.js";
import { OperationIdsSchema } from "./schemas/common.js";

// Manufacturing inputs outside these bounds are almost certainly unit mistakes.
// Bound them before geometry and time arithmetic so IEEE-754 overflow cannot
// turn an unsafe result into Infinity, NaN, or a misleading empty finding set.
const Finite = z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000);
const Positive = z.number().finite().min(1e-9).max(1_000_000_000_000_000);

export const Vector3Schema = z.object({
  x: Finite.describe("X coordinate in the job's declared length unit."),
  y: Finite.describe("Y coordinate in the job's declared length unit."),
  z: Finite.describe("Z coordinate in the job's declared length unit.")
}).strict();

export const Bounds3Schema = z.object({
  min: Vector3Schema.describe("Minimum X, Y, and Z corners of the bounds."),
  max: Vector3Schema.describe("Maximum X, Y, and Z corners of the bounds.")
}).strict().superRefine((bounds, context) => {
  for (const axis of ["x", "y", "z"] as const) {
    if (bounds.min[axis] > bounds.max[axis]) {
      context.addIssue({ code: "custom", message: `Minimum ${axis} bound must not exceed its maximum`, path: ["min", axis] });
    }
  }
});

const ProvenanceSchema = z.object({
  source: z.string().min(1).max(256).describe("Name of the shop, manufacturer, or document that supplied this value."),
  reference: z.string().max(1000).optional().describe("Optional URL, catalog identifier, or document reference."),
  verified: z.boolean().optional().describe("True only when an operator or trusted source confirmed this record.")
}).strict();

export const JobToolSchema = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int()]).optional().describe("Stable catalog identifier, when the source provides one."),
  number: z.number().int().positive().optional().describe("Tool number assigned by the shop or active job."),
  name: z.string().min(1).max(256).describe("Human-readable tool or assembly name."),
  type: z.string().min(1).max(128).optional().describe("Tool family, such as end mill, drill, boring bar, or turning holder."),
  holderStyle: z.string().max(128).optional().describe("Holder family or interface, when known."),
  machineLocation: z.string().max(128).optional().describe("Machine magazine or station location, when known."),
  lengthOutOfHolder: z.object({
    value: Positive.describe("Measured distance from the holder reference to the tool tip."),
    unit: z.enum(["mm", "in"]).describe("Length unit used for the measured tool stickout.")
  }).strict().optional().describe("Confirmed tool stickout and its length unit."),
  diameter: Positive.optional().describe("Tool cutting diameter in the feature's length unit."),
  cornerRadius: Finite.nonnegative().optional().describe("Cutting-edge corner radius in the feature's length unit."),
  fluteLength: Positive.optional().describe("Usable flute length in the feature's length unit."),
  overallLength: Positive.optional().describe("Overall tool length in the feature's length unit."),
  holderDiameter: Positive.optional().describe("Maximum holder diameter in the feature's length unit."),
  minFeatureDiameter: Positive.optional().describe("Smallest feature diameter this tool can physically enter, in the feature's length unit."),
  maxDepth: Positive.optional().describe("Maximum supported cutting depth in the feature's length unit."),
  materials: z.array(z.string().min(1).max(128)).max(100).default([]).describe("Materials approved or recommended by the source catalog."),
  operations: z.array(z.string().min(1).max(128)).max(100).default([]).describe("Operation types this tool is intended to perform."),
  coating: z.string().max(128).optional().describe("Tool coating, when known."),
  insert: z.string().max(128).optional().describe("Insert designation for an indexable tool."),
  grade: z.string().max(128).optional().describe("Insert or tool grade, when known."),
  maxRpm: Positive.optional().describe("Maximum rated spindle speed in revolutions per minute."),
  recommended: z.object({
    surfaceSpeed: Positive.optional().describe("Catalog cutting speed in the source's documented surface-speed unit."),
    feedPerTooth: Positive.optional().describe("Catalog feed per cutting edge in the job's length unit."),
    feedPerRev: Positive.optional().describe("Catalog feed per revolution in the job's length unit."),
    radialDepth: Positive.optional().describe("Recommended radial depth of cut in the job's length unit."),
    axialDepth: Positive.optional().describe("Recommended axial depth of cut in the job's length unit.")
  }).strict().optional().describe("Manufacturer or shop cutting data. Preserve the source units and provenance."),
  provenance: z.array(ProvenanceSchema).max(20).default([]).describe("Source records for catalog and cutting-data values.")
}).strict();

export const JobFeatureSchema = z.object({
  id: z.string().min(1).max(128).describe("Stable identifier used to associate recommendations with this feature."),
  type: z.string().min(1).max(128).describe("Feature or operation type, such as bore, groove, turning profile, or pocket."),
  diameter: Positive.optional().describe("Feature diameter in the units selected for this recommendation."),
  width: Positive.optional().describe("Feature width in the selected length unit."),
  depth: Positive.optional().describe("Required cutting depth in the selected length unit."),
  radius: Finite.nonnegative().optional().describe("Feature corner or profile radius in the selected length unit."),
  tolerance: Positive.optional().describe("Required dimensional tolerance in the selected length unit."),
  surfaceFinishRa: Positive.optional().describe("Required arithmetic-average surface roughness Ra in the source's documented unit."),
  internal: z.boolean().optional().describe("Whether the feature is internal, such as a bore or internal groove."),
  interruptedCut: z.boolean().optional().describe("Whether the cut is interrupted by slots, cross holes, or an interrupted surface.")
}).strict();

export const RecommendJobToolingSchema = z.object({
  material: z.string().min(1).max(128).describe("Workpiece material or grade as used by the tool catalog."),
  units: z.enum(["mm", "inch"]).optional().describe("Length unit used by feature and tool dimensions. If omitted, the report preserves unknown units and avoids unit conversion."),
  features: z.array(JobFeatureSchema).min(1).max(100).describe("Confirmed job features to match against the supplied tooling."),
  tools: z.array(JobToolSchema).max(20000).default([]).describe("Candidate tools from a shop or manufacturer catalog. Empty input uses configured and active-job records when available."),
  machine: z.object({
    maxToolDiameter: Positive.optional().describe("Maximum tool diameter the machine or holder can accept, in the selected length unit."),
    maxRpm: Positive.optional().describe("Maximum spindle speed in revolutions per minute."),
    maxToolLength: Positive.optional().describe("Maximum usable tool length in the selected length unit.")
  }).strict().optional().describe("Verified machine constraints used to reject incompatible candidates."),
  topK: z.number().int().min(1).max(10).default(3).describe("Maximum ranked tool recommendations to return per feature.")
}).strict();

export const ToolpathSegmentSchema = z.object({
  id: z.string().min(1).max(128).describe("Stable segment identifier included in any finding."),
  operationId: z.union([z.string().min(1).max(128), z.number().int()]).optional().describe("Source operation ID, when known."),
  motion: z.enum(["rapid", "feed", "arc"]).describe("Motion type represented by this segment."),
  start: Vector3Schema.describe("Segment start point in the same length unit as machine, stock, and fixture bounds."),
  end: Vector3Schema.describe("Segment end point in the same length unit as machine, stock, and fixture bounds."),
  feedRate: Positive.optional().describe("Commanded feed in the same length unit per minute used by the machine limit."),
  spindleRpm: Positive.optional().describe("Commanded spindle speed in revolutions per minute."),
  engagement: z.enum(["cut", "air", "unknown"]).default("unknown").describe("Whether the segment cuts material, moves through air, or has unknown engagement."),
  toolRadius: Finite.nonnegative().default(0).describe("Cutting tool radius in the shared job length unit."),
  holderRadius: Finite.nonnegative().default(0).describe("Maximum holder radius in the shared job length unit."),
  toolAxis: Vector3Schema.optional().describe("Tool-axis direction vector for approach-angle checks."),
  surfaceNormal: Vector3Schema.optional().describe("Surface normal vector for approach-angle checks.")
}).strict();

export const AnalyzeToolpathRiskSchema = z.object({
  segments: z.array(ToolpathSegmentSchema).min(1).max(10000).describe("Ordered toolpath segments to review. Coordinates, radii, and travel limits must use one shared length unit."),
  machine: z.object({
    travel: Bounds3Schema.describe("Machine travel envelope in the same coordinate frame and length unit as the segments."),
    maxFeedRate: Positive.optional().describe("Maximum allowed feed in the same length unit per minute as segment feed values."),
    maxSpindleRpm: Positive.optional().describe("Maximum spindle speed in revolutions per minute.")
  }).strict().describe("Verified machine travel and operating limits."),
  stock: Bounds3Schema.optional().describe("Stock bounding box in the same coordinate frame and length unit as the segments."),
  fixtures: z.array(z.object({
    id: z.string().min(1).max(128).describe("Stable fixture identifier included in findings."),
    bounds: Bounds3Schema.describe("Fixture bounds in the same coordinate frame and length unit as the segments.")
  }).strict()).max(100).default([]).describe("Known clamps, vises, fixtures, and other obstacle envelopes."),
  safetyMargin: Finite.nonnegative().default(0).describe("Extra clearance added around stock and fixtures in the shared length unit."),
  safeZ: Finite.optional().describe("Verified safe Z height in the same coordinate frame and length unit as the segments."),
  maxApproachAngleDeg: z.number().finite().min(0).max(90).optional().describe("Maximum permitted angle from the surface normal, in degrees, when both vectors are supplied.")
}).strict();

const MoveEventSchema = z.object({
  id: z.string().min(1).max(128).describe("Stable move identifier used to report time savings."),
  kind: z.literal("move").describe("Event type identifying this record as a motion move."),
  operationId: z.union([z.string().min(1).max(128), z.number().int()]).optional().describe("Source operation ID, when known."),
  motion: z.enum(["rapid", "feed"]).describe("Whether the move is rapid or feed motion."),
  start: Vector3Schema.describe("Start point. Coordinates and rates must use one consistent length unit."),
  end: Vector3Schema.describe("End point. Coordinates and rates must use one consistent length unit."),
  pathLength: Positive.optional().describe("Measured path length in the same unit used by the supplied rate."),
  feedRate: Positive.optional().describe("Feed rate in the shared length unit per minute. Required for a timed feed move."),
  engaged: z.boolean().optional().describe("True if cutting, false if non-cutting feed, or omit when engagement is unknown.")
}).strict();

const DwellEventSchema = z.object({
  id: z.string().min(1).max(128).describe("Stable dwell identifier used to report review opportunities."),
  kind: z.literal("dwell").describe("Event type identifying this record as a stationary dwell."),
  operationId: z.union([z.string().min(1).max(128), z.number().int()]).optional().describe("Source operation ID, when known."),
  seconds: Finite.nonnegative().describe("Dwell duration in seconds.")
}).strict();

const ToolChangeEventSchema = z.object({
  id: z.string().min(1).max(128).describe("Stable tool-change identifier used to report review opportunities."),
  kind: z.literal("tool_change").describe("Event type identifying this record as a tool change."),
  operationId: z.union([z.string().min(1).max(128), z.number().int()]).optional().describe("Source operation ID, when known."),
  seconds: Finite.nonnegative().optional().describe("Measured tool-change duration in seconds. Uses the configured default when omitted.")
}).strict();

export const AnalyzeCycleTimeSchema = z.object({
  events: z.array(z.discriminatedUnion("kind", [
    MoveEventSchema,
    DwellEventSchema,
    ToolChangeEventSchema
  ])).max(20000).describe("Ordered motion, dwell, and tool-change events. Unknown engagement remains unknown in the total."),
  machineRapidRate: Positive.describe("Rapid rate in the shared coordinate length unit per minute."),
  defaultToolChangeSeconds: Finite.nonnegative().default(8).describe("Fallback time in seconds for tool changes without measured duration."),
  opportunityThresholdSeconds: Finite.nonnegative().default(1).describe("Minimum event duration in seconds to include as a review opportunity.")
}).strict();

export const CycleTimeToolSchema = z.discriminatedUnion("source", [
  AnalyzeCycleTimeSchema.extend({ source: z.literal("motion_events").describe("Use supplied motion, dwell, and tool-change events.") }),
  z.object({
    source: z.literal("active_operations").describe("Request the active backend's estimate for selected operations."),
    operationIds: OperationIdsSchema.optional().describe("Optional exact operation IDs. Omit to include all operations in the active job.")
  }).strict()
]);

const OperationPacketOperationSchema = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int()]).describe("Stable operation identifier from the source tree."),
  name: z.string().min(1).max(256).describe("Operation name shown to the operator."),
  type: z.string().max(128).optional().describe("Operation strategy or family, when known."),
  toolNumber: z.number().int().positive().optional().describe("Assigned tool number, when known."),
  wcs: z.string().max(128).optional().describe("Work coordinate system used by this operation, when known."),
  plane: z.string().max(128).optional().describe("Programming plane used by this operation, when known."),
  feedRate: Positive.optional().describe("Feed value in the source's documented units."),
  spindleRpm: Positive.optional().describe("Spindle speed in revolutions per minute."),
  depth: Finite.optional().describe("Operation depth in the source's documented length unit."),
  estimatedCycleSeconds: Finite.nonnegative().optional().describe("Estimated or measured cycle time in seconds; label its source in notes."),
  toolpathDirty: z.boolean().optional().describe("Mapped toolpath dirty state. Omit if the source cannot establish it."),
  notes: z.array(z.string().max(1000)).max(20).default([]).describe("Operation-specific setup or review notes.")
}).strict();

export const GenerateOperationPacketSchema = z.object({
  part: z.record(z.string(), z.unknown()).optional().describe("Confirmed part identity and drawing information."),
  machine: z.record(z.string(), z.unknown()).optional().describe("Confirmed machine name, controller, and relevant limits."),
  stock: z.record(z.string(), z.unknown()).optional().describe("Stock material, dimensions, and explicit units."),
  wcs: z.record(z.string(), z.unknown()).optional().describe("Confirmed work coordinate system and origin details."),
  operations: z.array(OperationPacketOperationSchema).max(500).optional().describe("Operation tree records. Omit only when the active backend can supply them."),
  tools: z.array(JobToolSchema).max(20000).default([]).describe("Tool records used by the operations, including confirmed catalog data when available."),
  verification: z.object({
    simulationPassed: z.boolean().optional().describe("True only when a real simulation passed."),
    collisionCheckPassed: z.boolean().optional().describe("True only when a real collision check passed."),
    postRegressionReviewed: z.boolean().optional().describe("True only when a human reviewed the posted program against its approved baseline.")
  }).strict().optional().describe("External verification evidence. The packet generator does not run these checks."),
  notes: z.array(z.string().max(1000)).max(100).default([]).describe("General setup notes to include in the packet."),
  setupReferences: z.array(z.object({
    label: z.string().min(1).max(128).describe("Short title for a setup document or reference."),
    reference: z.string().min(1).max(1000).describe("URL, file path, or document identifier for the reference.")
  }).strict()).max(50).default([]).describe("External setup documents that operators should review.")
}).strict();

export const CalculateThreadTapSchema = z.object({
  system: z.enum(["metric", "unified"]).describe("Thread standard and interpretation: metric dimensions use millimeters; Unified dimensions use inches."),
  geometry: z.object({
    callout: z.string().max(128).optional().describe("Explicit callout such as M10x1.5 or 1/4-20. Conflicts with supplied dimensions are reported."),
    nominalDiameter: Positive.optional().describe("Nominal major diameter in mm for metric or inches for Unified."),
    pitch: Positive.optional().describe("Thread pitch in mm for metric or inches per thread for Unified."),
    tpi: Positive.optional().describe("Threads per inch. Used for Unified threads or cross-checked against metric pitch."),
    threadDepth: Positive.optional().describe("Optional confirmed thread engagement depth in the selected system's length unit.")
  }).strict().describe("Supply a confirmed thread callout or explicit dimensions. The tool does not read CAD geometry."),
  threadPercent: z.number().finite().min(40).max(90).default(75).describe("Target percentage of thread height for cut-tap drill guidance, from 40% to 90%. Form taps return a warning instead of an invented drill size."),
  tapType: z.enum(["cut", "form"]).default("cut").describe("Tap style. Form-tap drill sizing depends on maker and material and is not guessed."),
  cuttingSpeed: Positive.optional().describe("Cutting speed in m/min for metric or ft/min for Unified. Used only when rpm is omitted."),
  rpm: Positive.optional().describe("Confirmed spindle speed in revolutions per minute. If supplied, it is used instead of cuttingSpeed.")
}).strict();

const OdPointSchema = z.object({
  z: Finite.describe("Axial Z coordinate in the selected profile length unit."),
  diameter: Positive.describe("Finished outside diameter at this Z coordinate, in the selected length unit.")
}).strict();

export const PlanOdRoughFinishSchema = z.object({
  intent: z.string().min(1).max(2000).describe("Operator goal and relevant constraints. This creates a reviewable plan, not an executable toolpath."),
  units: z.enum(["mm", "inch"]).describe("Length unit used consistently by the profile, stock, tools, machine limits, and depth allowances."),
  material: z.string().min(1).max(128).describe("Confirmed workpiece material or grade."),
  stockDiameter: Positive.describe("Starting stock diameter in the selected length unit."),
  profile: z.array(OdPointSchema).min(2).max(1000).describe("Ordered outside-diameter profile points. Each point gives axial Z and finished diameter in the selected length unit."),
  tools: z.array(JobToolSchema).max(20000).default([]).describe("Candidate turning tools from the configured or supplied shop catalog."),
  machine: z.object({
    maxRpm: Positive.optional().describe("Verified spindle speed limit in revolutions per minute."),
    maxFeedRate: Positive.optional().describe("Verified feed limit in the selected length unit per minute.")
  }).strict().optional().describe("Optional verified machine limits used to filter candidates."),
  finishAllowanceRadial: Finite.nonnegative().describe("Radial material allowance left for the finish pass, in the selected length unit."),
  roughDepthRadial: Positive.optional().describe("Optional radial depth of cut per roughing pass, in the selected length unit."),
  topKTools: z.number().int().min(1).max(5).default(2).describe("Maximum tool candidates to return for each roughing and finishing role.")
}).strict();

type Vec = z.infer<typeof Vector3Schema>;
type Bounds = z.infer<typeof Bounds3Schema>;
type JobTool = z.infer<typeof JobToolSchema>;
type JobFeature = z.infer<typeof JobFeatureSchema>;
type ToolpathSegment = z.infer<typeof ToolpathSegmentSchema>;

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function toolIdentity(tool: JobTool): string {
  if (tool.id !== undefined) return String(tool.id);
  if (tool.number !== undefined) return String(tool.number);
  return tool.name;
}

function featureDimension(feature: JobFeature): number | undefined {
  return feature.diameter ?? feature.width;
}

function toolCompatibility(tool: JobTool, feature: JobFeature, material: string, machine?: {
  maxToolDiameter?: number;
  maxRpm?: number;
  maxToolLength?: number;
}) {
  const hardReject: string[] = [];
  const evidence: string[] = [];
  let score = 50;

  const materialKey = normalized(material);
  const materialMatches = tool.materials.length === 0 ||
    tool.materials.some(value => normalized(value) === materialKey || materialKey.includes(normalized(value)));
  if (tool.materials.length > 0 && !materialMatches) {
    hardReject.push("tool library does not list the requested material");
  } else if (materialMatches && tool.materials.length > 0) {
    score += 12;
    evidence.push("material compatibility comes from the supplied tool library");
  }

  const featureType = normalized(feature.type);
  const operationMatches = tool.operations.length === 0 ||
    tool.operations.some(value => {
      const operation = normalized(value);
      return operation === featureType || operation.includes(featureType) || featureType.includes(operation);
    });
  if (tool.operations.length > 0 && !operationMatches) {
    hardReject.push("tool library does not list this operation/feature type");
  } else if (operationMatches && tool.operations.length > 0) {
    score += 12;
    evidence.push("operation compatibility comes from the supplied tool library");
  }

  const dimension = featureDimension(feature);
  if (feature.internal === true && feature.diameter !== undefined && tool.diameter !== undefined) {
    if (tool.diameter > feature.diameter) hardReject.push("tool diameter exceeds the internal feature diameter");
    else {
      const ratio = tool.diameter / feature.diameter;
      score += Math.round(Math.max(0, 12 - Math.abs(0.65 - ratio) * 20));
    }
  } else if (dimension !== undefined && tool.diameter !== undefined) {
    score += 3;
  }

  if (feature.depth !== undefined) {
    if (tool.maxDepth !== undefined && tool.maxDepth < feature.depth) {
      hardReject.push("declared maximum machining depth is shorter than the feature depth");
    }
    if (tool.fluteLength !== undefined && tool.fluteLength < feature.depth) {
      hardReject.push("flute length is shorter than the feature depth");
    }
  }

  if (tool.minFeatureDiameter !== undefined && feature.diameter !== undefined &&
      feature.diameter < tool.minFeatureDiameter) {
    hardReject.push("feature diameter is below the tool's declared minimum");
  }

  if (machine?.maxToolDiameter !== undefined && tool.diameter !== undefined &&
      tool.diameter > machine.maxToolDiameter) {
    hardReject.push("tool diameter exceeds the supplied machine/tooling limit");
  }
  if (machine?.maxToolLength !== undefined && tool.overallLength !== undefined &&
      tool.overallLength > machine.maxToolLength) {
    hardReject.push("tool overall length exceeds the supplied machine/tooling limit");
  }
  if (machine?.maxRpm !== undefined && tool.maxRpm !== undefined) {
    score += tool.maxRpm >= machine.maxRpm ? 3 : 0;
  }

  if (tool.provenance.length > 0) {
    score += Math.min(8, tool.provenance.filter(item => item.verified === true).length * 2 + 2);
    evidence.push("recommendation includes supplied tooling provenance");
  }
  if (tool.recommended) {
    score += 5;
    evidence.push("supplier/shop cutting recommendations are available on the tool record");
  }

  return {
    accepted: hardReject.length === 0,
    score: Math.max(0, Math.min(100, score)),
    hardReject,
    evidence
  };
}

export function recommendJobTooling(input: z.infer<typeof RecommendJobToolingSchema>) {
  input = RecommendJobToolingSchema.parse(input);
  const features = input.features.map(feature => {
    const candidates = input.tools.map(tool => {
      const compatibility = toolCompatibility(tool, feature, input.material, input.machine);
      return {
        toolId: toolIdentity(tool),
        toolName: tool.name,
        toolNumber: tool.number,
        score: compatibility.score,
        accepted: compatibility.accepted,
        hardRejectReasons: compatibility.hardReject,
        evidence: compatibility.evidence,
        insert: tool.insert,
        grade: tool.grade,
        coating: tool.coating,
        recommended: tool.recommended,
        provenance: tool.provenance
      };
    });
    const accepted = candidates
      .filter(candidate => candidate.accepted)
      .sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName))
      .slice(0, input.topK);
    const rejected = candidates
      .filter(candidate => !candidate.accepted)
      .slice(0, 25);
    return {
      feature,
      recommendations: accepted,
      rejected,
      status: accepted.length > 0 ? "RECOMMENDATIONS_AVAILABLE" : "NO_COMPATIBLE_TOOL"
    };
  });

  return {
    schema: "mastercam-mcp/job-tooling/v1",
    material: input.material,
    units: input.units ?? null,
    candidateCount: input.tools.length,
    status: input.tools.length > 0 ? "GROUNDED_TO_SUPPLIED_TOOL_DATA" : "NO_TOOL_DATA",
    features,
    evidenceHash: sha256Of(input),
    safety:
      "Recommendations are constrained to the supplied tool library and declared machine/job data. Verify holder clearance, insert geometry, manufacturer limits, workholding, and simulation before machining."
  };
}

function distance(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function expandedSweep(segment: ToolpathSegment, margin: number): Bounds {
  const radius = Math.max(segment.toolRadius, segment.holderRadius) + margin;
  return {
    min: {
      x: Math.min(segment.start.x, segment.end.x) - radius,
      y: Math.min(segment.start.y, segment.end.y) - radius,
      z: Math.min(segment.start.z, segment.end.z) - radius
    },
    max: {
      x: Math.max(segment.start.x, segment.end.x) + radius,
      y: Math.max(segment.start.y, segment.end.y) + radius,
      z: Math.max(segment.start.z, segment.end.z) + radius
    }
  };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function outside(point: Vec, bounds: Bounds): string[] {
  const axes: string[] = [];
  if (point.x < bounds.min.x || point.x > bounds.max.x) axes.push("X");
  if (point.y < bounds.min.y || point.y > bounds.max.y) axes.push("Y");
  if (point.z < bounds.min.z || point.z > bounds.max.z) axes.push("Z");
  return axes;
}

function vectorMagnitude(v: Vec): number {
  return Math.hypot(v.x, v.y, v.z);
}

function approachAngleDeg(toolAxis: Vec, normal: Vec): number | undefined {
  const am = vectorMagnitude(toolAxis);
  const nm = vectorMagnitude(normal);
  if (am === 0 || nm === 0) return undefined;
  const dot = ((-toolAxis.x * normal.x) + (-toolAxis.y * normal.y) + (-toolAxis.z * normal.z)) / (am * nm);
  const clamped = Math.max(-1, Math.min(1, dot));
  return Math.acos(clamped) * 180 / Math.PI;
}

export function analyzeToolpathRisk(input: z.infer<typeof AnalyzeToolpathRiskSchema>) {
  input = AnalyzeToolpathRiskSchema.parse(input);
  const findings: Array<{
    id: string;
    severity: "blocker" | "warning" | "unknown";
    segmentId: string;
    message: string;
    evidence?: unknown;
  }> = [];

  for (const segment of input.segments) {
    const startOutside = outside(segment.start, input.machine.travel);
    const endOutside = outside(segment.end, input.machine.travel);
    if (startOutside.length > 0 || endOutside.length > 0) {
      findings.push({
        id: "machine_overtravel",
        severity: "blocker",
        segmentId: segment.id,
        message: "Segment endpoint exceeds the declared machine travel envelope",
        evidence: { startOutside, endOutside }
      });
    }

    if (input.machine.maxFeedRate !== undefined && segment.feedRate !== undefined &&
        segment.feedRate > input.machine.maxFeedRate) {
      findings.push({
        id: "feed_limit",
        severity: "blocker",
        segmentId: segment.id,
        message: "Segment feed rate exceeds the declared machine limit",
        evidence: { feedRate: segment.feedRate, maxFeedRate: input.machine.maxFeedRate }
      });
    }

    if (input.machine.maxSpindleRpm !== undefined && segment.spindleRpm !== undefined &&
        segment.spindleRpm > input.machine.maxSpindleRpm) {
      findings.push({
        id: "spindle_limit",
        severity: "blocker",
        segmentId: segment.id,
        message: "Segment spindle speed exceeds the declared machine limit",
        evidence: { spindleRpm: segment.spindleRpm, maxSpindleRpm: input.machine.maxSpindleRpm }
      });
    }

    const sweep = expandedSweep(segment, input.safetyMargin);
    for (const fixture of input.fixtures) {
      if (intersects(sweep, fixture.bounds)) {
        findings.push({
          id: "fixture_swept_envelope",
          severity: "blocker",
          segmentId: segment.id,
          message: "Conservative swept envelope intersects a supplied fixture bounding box",
          evidence: { fixtureId: fixture.id, sweep }
        });
      }
    }

    if (segment.motion === "rapid") {
      if (input.safeZ !== undefined && Math.min(segment.start.z, segment.end.z) < input.safeZ) {
        findings.push({
          id: "rapid_below_safe_z",
          severity: "warning",
          segmentId: segment.id,
          message: "Rapid motion occurs below the supplied safe-Z plane",
          evidence: { safeZ: input.safeZ, startZ: segment.start.z, endZ: segment.end.z }
        });
      }
      if (input.stock && intersects(sweep, input.stock)) {
        findings.push({
          id: "rapid_stock_envelope",
          severity: "warning",
          segmentId: segment.id,
          message: "Rapid swept envelope intersects the supplied stock bounding box",
          evidence: { sweep }
        });
      }
      const planarDistance = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
      if (planarDistance > 0 && segment.end.z < segment.start.z &&
          (input.safeZ === undefined || segment.end.z < input.safeZ)) {
        findings.push({
          id: "diagonal_down_rapid",
          severity: "warning",
          segmentId: segment.id,
          message: "Rapid combines lateral motion with a downward Z move near the machining region"
        });
      }
    }

    if (input.maxApproachAngleDeg !== undefined && segment.toolAxis && segment.surfaceNormal) {
      const angle = approachAngleDeg(segment.toolAxis, segment.surfaceNormal);
      if (angle === undefined) {
        findings.push({
          id: "approach_angle_unknown",
          severity: "unknown",
          segmentId: segment.id,
          message: "Tool-axis or surface-normal vector has zero magnitude"
        });
      } else if (angle > input.maxApproachAngleDeg) {
        findings.push({
          id: "approach_angle",
          severity: "warning",
          segmentId: segment.id,
          message: "Tool approach angle exceeds the supplied review threshold",
          evidence: { angleDeg: angle, thresholdDeg: input.maxApproachAngleDeg }
        });
      }
    }

    if (segment.motion === "arc") {
      findings.push({
        id: "arc_envelope_scope",
        severity: "unknown",
        segmentId: segment.id,
        message: "Arc risk uses endpoint bounding data only unless the caller pre-segments the arc; full arc sweep remains unverified"
      });
    }
  }

  const blockers = findings.filter(item => item.severity === "blocker").length;
  const warnings = findings.filter(item => item.severity === "warning").length;
  const unknown = findings.filter(item => item.severity === "unknown").length;
  const status = blockers > 0 ? "BLOCKED" : warnings > 0 || unknown > 0 ? "REVIEW" : "NO_RISK_FOUND_IN_SUPPLIED_MODEL";

  return {
    schema: "mastercam-mcp/toolpath-risk/v1",
    status,
    summary: { blockers, warnings, unknown, segments: input.segments.length },
    findings,
    evidenceHash: sha256Of(input),
    safety:
      "This is conservative deterministic review of the supplied path model. It is not a replacement for release-specific machine simulation, stock-removal verification, controller behavior, or collision checking."
  };
}

export function analyzeCycleTime(input: z.infer<typeof AnalyzeCycleTimeSchema>) {
  input = AnalyzeCycleTimeSchema.parse(input);
  let cuttingSeconds = 0;
  let airFeedSeconds = 0;
  let rapidSeconds = 0;
  let dwellSeconds = 0;
  let toolChangeSeconds = 0;
  let unknownMoveCount = 0;
  let unknownEngagementSeconds = 0;
  const opportunities: Array<{
    id: string;
    kind: string;
    seconds: number;
    message: string;
    operationId?: string | number;
  }> = [];

  for (const event of input.events) {
    if (event.kind === "dwell") {
      dwellSeconds += event.seconds;
      if (event.seconds >= input.opportunityThresholdSeconds) {
        opportunities.push({
          id: event.id,
          kind: "dwell",
          seconds: event.seconds,
          message: "Review whether this dwell is process-required",
          operationId: event.operationId
        });
      }
      continue;
    }
    if (event.kind === "tool_change") {
      const seconds = event.seconds ?? input.defaultToolChangeSeconds;
      toolChangeSeconds += seconds;
      if (seconds >= input.opportunityThresholdSeconds) {
        opportunities.push({
          id: event.id,
          kind: "tool_change",
          seconds,
          message: "Review operation ordering and tool reuse before removing any tool change",
          operationId: event.operationId
        });
      }
      continue;
    }

    const length = event.pathLength ?? distance(event.start, event.end);
    const rate = event.motion === "rapid" ? input.machineRapidRate : event.feedRate;
    if (rate === undefined || rate <= 0) {
      unknownMoveCount += 1;
      continue;
    }
    const seconds = length / rate * 60;
    if (event.motion === "rapid") {
      rapidSeconds += seconds;
      if (seconds >= input.opportunityThresholdSeconds) {
        opportunities.push({
          id: event.id,
          kind: "rapid",
          seconds,
          message: "Review linking/retract geometry for a shorter collision-safe positioning move",
          operationId: event.operationId
        });
      }
    } else if (event.engaged === true) {
      cuttingSeconds += seconds;
    } else if (event.engaged === false) {
      airFeedSeconds += seconds;
      if (seconds >= input.opportunityThresholdSeconds) {
        opportunities.push({
          id: event.id,
          kind: "air_feed",
          seconds,
          message: "Feed move is marked non-engaged; review whether it can be shortened or converted to a verified safe link",
          operationId: event.operationId
        });
      }
    } else {
      unknownMoveCount += 1;
      unknownEngagementSeconds += seconds;
    }
  }

  const knownSeconds = cuttingSeconds + airFeedSeconds + rapidSeconds + dwellSeconds + toolChangeSeconds;
  const nonCuttingSeconds = airFeedSeconds + rapidSeconds + dwellSeconds + toolChangeSeconds;
  opportunities.sort((a, b) => b.seconds - a.seconds);

  return {
    schema: "mastercam-mcp/cycle-time-analysis/v1",
    knownSeconds,
    breakdown: {
      cuttingSeconds,
      airFeedSeconds,
      rapidSeconds,
      dwellSeconds,
      toolChangeSeconds,
      nonCuttingSeconds
    },
    nonCuttingShare: knownSeconds > 0 ? nonCuttingSeconds / knownSeconds : 0,
    unknownMoveCount,
    unknownEngagementSeconds,
    opportunities: opportunities.slice(0, 100),
    upperBoundSecondsIfListedNonCuttingWereRemoved: opportunities.reduce((sum, item) => sum + item.seconds, 0),
    evidenceHash: sha256Of(input),
    safety:
      "Opportunity seconds are an upper bound, not achievable savings. Do not shorten rapids, retracts, dwells, or tool changes without collision, process, acceleration/jerk, and machine verification."
  };
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function generateOperationPacket(input: z.infer<typeof GenerateOperationPacketSchema>) {
  input = GenerateOperationPacketSchema.parse(input);
  const operations = input.operations ?? [];
  const toolsByNumber = new Map<number, JobTool>();
  for (const tool of input.tools) {
    if (tool.number !== undefined) toolsByNumber.set(tool.number, tool);
  }

  const unresolvedTools = operations
    .filter(operation => operation.toolNumber !== undefined && !toolsByNumber.has(operation.toolNumber))
    .map(operation => ({ operationId: operation.id, toolNumber: operation.toolNumber }));
  const dirty = operations.filter(operation => operation.toolpathDirty === true).map(operation => operation.id);
  const estimatedCycleSeconds = operations.reduce(
    (sum, operation) => sum + (operation.estimatedCycleSeconds ?? 0),
    0
  );

  const operationLines = operations.map((operation, index) => {
    const notes = operation.notes.join("; ");
    return [
      String(index + 1),
      displayValue(operation.id),
      operation.name,
      displayValue(operation.type),
      displayValue(operation.toolNumber),
      displayValue(operation.wcs),
      displayValue(operation.plane),
      displayValue(operation.feedRate),
      displayValue(operation.spindleRpm),
      displayValue(operation.estimatedCycleSeconds),
      notes
    ].join(" | ");
  });

  const toolLines = input.tools.map(tool => [
    displayValue(tool.number),
    tool.name,
    displayValue(tool.type),
    displayValue(tool.diameter),
    displayValue(tool.insert),
    displayValue(tool.grade),
    displayValue(tool.fluteLength),
    displayValue(tool.lengthOutOfHolder),
    displayValue(tool.holderStyle),
    displayValue(tool.machineLocation),
    tool.provenance.map(item => item.source).join(", ")
  ].join(" | "));

  const packet = [
    "# Setup and Operation Packet",
    "",
    "## Job",
    "- Part: " + displayValue(input.part?.name ?? input.part?.fileName ?? input.part?.path),
    "- Machine: " + displayValue(input.machine?.name ?? input.machine?.machine),
    "- Stock: " + displayValue(input.stock?.description ?? input.stock?.type ?? input.stock),
    "- WCS: " + displayValue(input.wcs?.name ?? input.wcs?.id ?? input.wcs),
    "",
    "## Verification state",
    "- Simulation: " + displayValue(input.verification?.simulationPassed),
    "- Collision check: " + displayValue(input.verification?.collisionCheckPassed),
    "- Post regression reviewed: " + displayValue(input.verification?.postRegressionReviewed),
    "",
    "## Operations",
    "Seq | ID | Name | Type | Tool | WCS | Plane | Feed | RPM | Est. sec | Notes",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...operationLines,
    "",
    "## Tool list",
    "Tool # | Name | Type | Diameter | Insert | Grade | Cutting length | Length out of holder | Holder style | Machine location | Provenance",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...toolLines,
    "",
    "## Shop notes",
    ...input.notes.map(note => "- " + note),
    ...(input.setupReferences.length > 0 ? ["", "## Setup references", ...input.setupReferences.map(item => `- ${item.label}: ${item.reference}`)] : [])
  ].join("\n");

  return {
    schema: "mastercam-mcp/operation-packet/v1",
    markdown: packet,
    summary: {
      operationCount: operations.length,
      toolCount: input.tools.length,
      estimatedCycleSeconds,
      dirtyOperationIds: dirty,
      unresolvedTools
    },
    evidenceHash: sha256Of(input),
    safety:
      "Generated notes reflect only supplied programming state. Operators must verify revision, workholding, offsets, tool assembly/stickout, simulation, and released NC at the machine."
  };
}

function parseFraction(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  const mixed = trimmed.match(/^(\d+)?\s*(\d+)\/(\d+)$/);
  if (!mixed) return undefined;
  const whole = mixed[1] ? Number(mixed[1]) : 0;
  const numerator = Number(mixed[2]);
  const denominator = Number(mixed[3]);
  if (!denominator) return undefined;
  const parsed = whole + numerator / denominator;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveThreadGeometry(input: z.infer<typeof CalculateThreadTapSchema>) {
  let nominalDiameter = input.geometry.nominalDiameter;
  let pitch = input.geometry.pitch;
  let tpi = input.geometry.tpi;
  const callout = input.geometry.callout?.trim();

  if (callout && input.system === "metric") {
    const match = callout.match(/^M\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      nominalDiameter ??= parsePositiveNumber(match[1] ?? "");
      pitch ??= parsePositiveNumber(match[2] ?? "");
    }
  }

  if (callout && input.system === "unified") {
    const match = callout.match(/^([\d./\s]+)\s*-\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      nominalDiameter ??= parseFraction(match[1] ?? "");
      tpi ??= parsePositiveNumber(match[2] ?? "");
    }
  }

  if (input.system === "unified" && tpi !== undefined) pitch ??= 1 / tpi;
  if (input.system === "metric" && pitch !== undefined) tpi ??= 25.4 / pitch;

  return { nominalDiameter, pitch, tpi, callout };
}

export function calculateThreadTap(input: z.infer<typeof CalculateThreadTapSchema>) {
  input = CalculateThreadTapSchema.parse(input);
  const resolved = resolveThreadGeometry(input);
  const coreGeometry = [resolved.nominalDiameter, resolved.pitch, resolved.tpi];
  if (coreGeometry.some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) {
    return {
      schema: "mastercam-mcp/thread-tap/v1",
      status: "INVALID_GEOMETRY",
      callout: resolved.callout,
      reason: "The supplied thread dimensions produce a non-finite or non-positive pitch/diameter."
    };
  }
  if (resolved.nominalDiameter === undefined || resolved.pitch === undefined) {
    return {
      schema: "mastercam-mcp/thread-tap/v1",
      status: "INSUFFICIENT_GEOMETRY",
      resolved,
      required: input.system === "metric"
        ? ["nominalDiameter and pitch, or a metric callout like M10x1.5"]
        : ["nominalDiameter and TPI, or a unified callout like 1/4-20"],
      evidenceHash: sha256Of(input)
    };
  }

  const d = resolved.nominalDiameter;
  const p = resolved.pitch;
  const expectedPitch = resolved.tpi === undefined
    ? undefined
    : input.system === "metric" ? 25.4 / resolved.tpi : 1 / resolved.tpi;
  const pitchTolerance = expectedPitch === undefined
    ? 0
    : Math.max(1e-12, Math.max(p, expectedPitch) * 1e-3);
  if (p >= d || (expectedPitch !== undefined &&
      Math.abs(p - expectedPitch) > pitchTolerance)) {
    return {
      schema: "mastercam-mcp/thread-tap/v1",
      status: "INVALID_GEOMETRY",
      callout: resolved.callout,
      reason: "Pitch must be smaller than nominal diameter, and supplied pitch/TPI values must agree."
    };
  }
  const warnings: string[] = [];
  let tapDrill: number | undefined;

  if (input.tapType === "cut") {
    tapDrill = input.system === "metric"
      ? d - (input.threadPercent * p / 76.98)
      : d - (0.01299 * input.threadPercent / (resolved.tpi ?? (1 / p)));
  } else {
    warnings.push("Form-tap drill sizing is highly manufacturer/material dependent; this tool intentionally does not invent a generic form-tap drill.");
  }

  const pitchDiameter = d - 0.649519 * p;
  const basicInternalMinorDiameter = d - 1.082532 * p;
  const rpm = input.rpm ?? (
    input.cuttingSpeed !== undefined
      ? input.system === "metric"
        ? input.cuttingSpeed * 1000 / (Math.PI * d)
        : input.cuttingSpeed * 12 / (Math.PI * d)
      : undefined
  );
  const feedRate = rpm !== undefined
    ? input.system === "metric"
      ? rpm * p
      : rpm / (resolved.tpi ?? (1 / p))
    : undefined;

  if ([pitchDiameter, basicInternalMinorDiameter, tapDrill, rpm, feedRate].some(
    value => value !== undefined && !Number.isFinite(value)
  ) || pitchDiameter <= 0 || basicInternalMinorDiameter <= 0 || (tapDrill !== undefined && tapDrill <= 0)) {
    return {
      schema: "mastercam-mcp/thread-tap/v1",
      status: "INVALID_GEOMETRY",
      callout: resolved.callout,
      reason: "The supplied dimensions or cutting inputs produce invalid derived thread values."
    };
  }

  return {
    schema: "mastercam-mcp/thread-tap/v1",
    status: "CALCULATED",
    units: input.system === "metric" ? "mm" : "inch",
    resolved: {
      nominalDiameter: d,
      pitch: p,
      tpi: resolved.tpi,
      callout: resolved.callout
    },
    geometry: {
      pitchDiameter,
      basicInternalMinorDiameter,
      requestedThreadPercent: input.threadPercent,
      tapDrill
    },
    cutting: {
      rpm,
      feedRate,
      feedUnit: input.system === "metric" ? "mm/min" : "in/min",
      cuttingSpeed: input.cuttingSpeed
    },
    warnings,
    evidenceHash: sha256Of(input),
    safety:
      "Calculations use basic 60-degree thread/tapping formulas. Confirm thread class/tolerance, tap manufacturer drill recommendation, material, coolant, machine synchronization, blind-hole clearance, and gauge requirements."
  };
}

function operationToolCandidates(
  tools: JobTool[],
  operation: string,
  material: string,
  topK: number
) {
  const feature: JobFeature = { id: operation, type: operation };
  return tools
    .map(tool => ({ tool, compatibility: toolCompatibility(tool, feature, material) }))
    .filter(item => item.compatibility.accepted)
    .sort((a, b) => b.compatibility.score - a.compatibility.score)
    .slice(0, topK)
    .map(item => ({
      toolId: toolIdentity(item.tool),
      toolName: item.tool.name,
      toolNumber: item.tool.number,
      score: item.compatibility.score,
      recommended: item.tool.recommended,
      provenance: item.tool.provenance
    }));
}

export function planOdRoughFinish(input: z.infer<typeof PlanOdRoughFinishSchema>) {
  const maxRoughPassPreview = 1000;
  input = PlanOdRoughFinishSchema.parse(input);
  const minProfileDiameter = Math.min(...input.profile.map(point => point.diameter));
  const maxProfileDiameter = Math.max(...input.profile.map(point => point.diameter));
  const radialRemoval = (input.stockDiameter - minProfileDiameter) / 2;
  const warnings: string[] = [];

  if (input.stockDiameter <= maxProfileDiameter) {
    warnings.push("Stock diameter does not exceed the maximum OD profile diameter; verify stock/model orientation.");
  }

  const roughTools = operationToolCandidates(input.tools, "turning rough", input.material, input.topKTools);
  const finishTools = operationToolCandidates(input.tools, "turning finish", input.material, input.topKTools);
  const selectedRough = roughTools[0];
  const selectedFinish = finishTools[0];
  const roughDepth = input.roughDepthRadial ?? selectedRough?.recommended?.radialDepth;

  const blockers: string[] = [];
  if (!selectedRough) blockers.push("No compatible rough-turning tool is present in the supplied tool library.");
  if (!selectedFinish) blockers.push("No compatible finish-turning tool is present in the supplied tool library.");
  if (roughDepth === undefined || roughDepth <= 0) {
    blockers.push("No radial roughing depth was supplied or proven by the selected tool record.");
  }
  if (radialRemoval < input.finishAllowanceRadial) {
    blockers.push("Finish allowance exceeds available radial stock.");
  }

  const roughRemoval = Math.max(0, radialRemoval - input.finishAllowanceRadial);
  const calculatedPassCount = roughDepth !== undefined && roughDepth > 0
    ? Math.ceil(roughRemoval / roughDepth)
    : 0;
  const passCount = Number.isSafeInteger(calculatedPassCount) ? calculatedPassCount : null;
  const roughPassesTruncated = passCount === null || passCount > maxRoughPassPreview;
  if (roughPassesTruncated) {
    blockers.push(`Roughing plan exceeds the ${maxRoughPassPreview}-pass preview limit; adjust stock or verified roughing depth before planning.`);
  }
  const roughPasses = Array.from({ length: passCount === null ? 0 : Math.min(passCount, maxRoughPassPreview) }, (_, index) => {
    const remainingBeforeFinish = Math.max(
      input.finishAllowanceRadial,
      roughRemoval - roughDepth! * (index + 1) + input.finishAllowanceRadial
    );
    return {
      pass: index + 1,
      profileRadialOffset: remainingBeforeFinish,
      purpose: "roughing envelope offset from final OD profile"
    };
  });

  const rpmLimit = input.machine?.maxRpm;
  const checkCandidate = (candidate: typeof selectedRough) => {
    const surfaceSpeed = candidate?.recommended?.surfaceSpeed;
    if (surfaceSpeed === undefined) return undefined;
    const rpm = input.units === "mm"
      ? surfaceSpeed * 1000 / (Math.PI * Math.max(maxProfileDiameter, 0.000001))
      : surfaceSpeed * 12 / (Math.PI * Math.max(maxProfileDiameter, 0.000001));
    return rpmLimit !== undefined ? Math.min(rpm, rpmLimit) : rpm;
  };

  return {
    schema: "mastercam-mcp/od-rough-finish-plan/v1",
    status: blockers.length > 0 ? "BLOCKED" : "PLAN_READY_FOR_REVIEW",
    executable: false,
    intent: input.intent,
    blockers,
    warnings,
    geometry: {
      stockDiameter: input.stockDiameter,
      minProfileDiameter,
      maxProfileDiameter,
      radialRemoval,
      finishAllowanceRadial: input.finishAllowanceRadial
    },
    toolSelection: {
      rough: selectedRough,
      finish: selectedFinish,
      roughAlternates: roughTools,
      finishAlternates: finishTools
    },
    plan: {
      roughDepthRadial: roughDepth,
      roughPassCount: passCount,
      roughPasses,
      roughPassesTruncated,
      finishPass: {
        profileRadialOffset: 0,
        profile: input.profile
      },
      suggestedRoughRpm: checkCandidate(selectedRough),
      suggestedFinishRpm: checkCandidate(selectedFinish)
    },
    verificationRequired: [
      "confirm stock, chuck/jaw/workholding geometry and Z datum",
      "verify insert orientation, holder hand, nose radius and compensation",
      "check machine travel and spindle/feed limits",
      "regenerate against the actual Mastercam geometry",
      "run stock-removal and collision simulation",
      "review the posted NC with semantic post regression before release"
    ],
    evidenceHash: sha256Of(input),
    safety:
      "This tool creates a non-executable process-plan preview. It does not create Mastercam operations, generate toolpaths, post NC, transfer code, or authorize machine execution."
  };
}
