import * as z from "zod/v4";

export const LinearTravelSchema = z.object({
  x: z.number().finite().positive().max(10_000),
  y: z.number().finite().positive().max(10_000),
  z: z.number().finite().positive().max(10_000),
  unit: z.enum(["mm", "in"])
}).strict();

export const RotaryTravelSchema = z.object({
  a: z.number().finite().max(360).optional(),
  b: z.number().finite().max(360).optional(),
  c: z.number().finite().max(360).optional(),
  unit: z.enum(["deg"]).default("deg")
}).strict();

export const ControllerSchema = z.object({
  manufacturer: z.string().min(1).max(64),
  model: z.string().min(1).max(64),
  version: z.string().min(1).max(32)
}).strict();

export const ToolChangerSchema = z.object({
  type: z.enum(["umbrella", "chain", "carousel", "arm"]),
  capacity: z.number().int().positive().max(500),
  toolToToolTimeSec: z.number().finite().nonnegative().optional()
}).strict();

export const SpindleSchema = z.object({
  maxRpm: z.number().finite().positive().max(100_000),
  maxPowerKw: z.number().finite().positive().max(1000),
  maxTorqueNm: z.number().finite().positive().max(10000),
  taper: z.string().min(1).max(32),
  orientation: z.enum(["vertical", "horizontal", "universal"])
}).strict();

export const FeedSchema = z.object({
  maxFeedMmMin: z.number().finite().positive().max(100_000),
  maxAccelerationMmSec2: z.number().finite().positive().max(50_000).optional()
}).strict();

export const CoolantSchema = z.object({
  flood: z.boolean(),
  throughSpindle: z.boolean(),
  throughSpindleMaxBar: z.number().finite().positive().max(500).optional()
}).strict();

export const ProbingSchema = z.object({
  supported: z.boolean(),
  type: z.enum(["touch", "laser", "optical"]).optional(),
  maxStylusLengthMm: z.number().finite().positive().max(1000).optional()
}).strict();

export const WorkOffsetSchema = z.object({
  maxWorkOffsets: z.number().int().positive().max(100),
  supportsG541: z.boolean().default(false)
}).strict();

export const MachineProfileSchema = z.object({
  name: z.string().min(1).max(128),
  controller: ControllerSchema,
  axes: z.number().int().min(3).max(9),
  linearTravels: LinearTravelSchema,
  rotaryTravels: RotaryTravelSchema.optional(),
  spindle: SpindleSchema,
  feed: FeedSchema,
  toolChanger: ToolChangerSchema.optional(),
  coolant: CoolantSchema.optional(),
  probing: ProbingSchema.optional(),
  workOffsets: WorkOffsetSchema.optional()
}).strict();

export type MachineProfile = z.infer<typeof MachineProfileSchema>;

export const OperationForValidationSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(256),
  type: z.string().min(1).max(64),
  feedRate: z.object({
    value: z.number().finite().positive(),
    unit: z.enum(["mm/min", "in/min", "mm/rev", "in/rev"])
  }).optional(),
  spindleSpeed: z.object({
    value: z.number().finite().positive(),
    unit: z.enum(["rpm", "css_m_min", "css_ft_min"])
  }).optional(),
  tool: z.number().int().positive().optional(),
  toolDiameter: z.number().finite().positive().max(1000).optional(),
  fluteCount: z.number().int().positive().max(50).optional(),
  stepover: z.number().finite().nonnegative().optional(),
  stepdown: z.number().finite().nonnegative().optional(),
  radialDoc: z.number().finite().nonnegative().optional(),
  axialDoc: z.number().finite().nonnegative().optional(),
  material: z.string().min(1).max(64).optional(),
  toolMaterial: z.enum(["carbide", "hss", "cermet", "ceramic", "pcd", "cbn"]).optional(),
  coating: z.string().min(1).max(32).optional(),
  stickout: z.number().finite().nonnegative().optional(),
  holder: z.string().min(1).max(64).optional()
}).strict();

export type OperationForValidation = z.infer<typeof OperationForValidationSchema>;

export const ValidateMachineProfileInputSchema = z.object({
  operation: OperationForValidationSchema,
  profile: MachineProfileSchema
}).strict();

export const ValidateMachineProfileOutputSchema = z.object({
  valid: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    pass: z.boolean(),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    severity: z.enum(["error", "warning", "info"]),
    message: z.string().optional()
  }).strict()),
  summary: z.object({
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    info: z.number().int().nonnegative()
  }).strict()
}).strict();