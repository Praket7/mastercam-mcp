import * as z from "zod/v4";

export const LinearTravelSchema = z.object({
  x: z.number().finite().positive().max(10_000).describe("Maximum verified linear travel along X from the machine home reference."),
  y: z.number().finite().positive().max(10_000).describe("Maximum verified linear travel along Y from the machine home reference."),
  z: z.number().finite().positive().max(10_000).describe("Maximum verified linear travel along Z from the machine home reference."),
  unit: z.enum(["mm", "in"]).describe("Length unit shared by the X, Y, and Z travel limits.")
}).strict();

export const RotaryTravelSchema = z.object({
  a: z.number().finite().max(360).optional().describe("Verified angular travel limit for the A rotary axis, in degrees."),
  b: z.number().finite().max(360).optional().describe("Verified angular travel limit for the B rotary axis, in degrees."),
  c: z.number().finite().max(360).optional().describe("Verified angular travel limit for the C rotary axis, in degrees."),
  unit: z.enum(["deg"]).default("deg").describe("Angular unit for all supplied rotary-axis limits.")
}).strict();

export const ControllerSchema = z.object({
  manufacturer: z.string().min(1).max(64).describe("Controller manufacturer, copied from a verified controller or machine record."),
  model: z.string().min(1).max(64).describe("Controller model or family as identified by the verified machine record."),
  version: z.string().min(1).max(32).describe("Controller software or firmware version, when known.")
}).strict();

export const ToolChangerSchema = z.object({
  type: z.enum(["umbrella", "chain", "carousel", "arm"]).describe("Physical tool-changer style reported for the machine."),
  capacity: z.number().int().positive().max(500).describe("Number of tool positions available in the tool changer."),
  toolToToolTimeSec: z.number().finite().nonnegative().optional().describe("Verified tool-to-tool change time in seconds, if available.")
}).strict();

export const SpindleSchema = z.object({
  maxRpm: z.number().finite().positive().max(100_000).describe("Verified maximum spindle speed in revolutions per minute."),
  maxPowerKw: z.number().finite().positive().max(1000).describe("Verified maximum spindle power in kilowatts."),
  maxTorqueNm: z.number().finite().positive().max(10000).describe("Verified maximum spindle torque in newton-metres."),
  taper: z.string().min(1).max(32).describe("Spindle taper or tool-interface designation, such as CAT40 or HSK63."),
  orientation: z.enum(["vertical", "horizontal", "universal"]).describe("Machine spindle orientation category.")
}).strict();

export const FeedSchema = z.object({
  maxFeedMmMin: z.number().finite().positive().max(100_000).describe("Verified maximum linear feed in millimetres per minute."),
  maxAccelerationMmSec2: z.number().finite().positive().max(50_000).optional().describe("Verified maximum linear acceleration in millimetres per second squared.")
}).strict();

export const CoolantSchema = z.object({
  flood: z.boolean().describe("Whether the machine has flood coolant, based on the verified machine configuration."),
  throughSpindle: z.boolean().describe("Whether the machine supplies coolant through the spindle."),
  throughSpindleMaxBar: z.number().finite().positive().max(500).optional().describe("Verified maximum through-spindle coolant pressure in bar.")
}).strict();

export const ProbingSchema = z.object({
  supported: z.boolean().describe("Whether probing is installed and enabled for this machine."),
  type: z.enum(["touch", "laser", "optical"]).optional().describe("Installed probing technology, when known."),
  maxStylusLengthMm: z.number().finite().positive().max(1000).optional().describe("Verified maximum probe stylus length in millimetres.")
}).strict();

export const WorkOffsetSchema = z.object({
  maxWorkOffsets: z.number().int().positive().max(100).describe("Maximum number of work coordinate offsets supported by the controller."),
  supportsG541: z.boolean().default(false).describe("Whether this controller explicitly supports the G54.1 extended-offset syntax.")
}).strict();

export const MachineProfileSchema = z.object({
  name: z.string().min(1).max(128).describe("Human-readable machine profile name. Use a verified shop or manufacturer profile."),
  controller: ControllerSchema.describe("Verified controller identity used to interpret machine limits."),
  axes: z.number().int().min(3).max(9).describe("Total number of controlled machine axes, including rotary axes."),
  linearTravels: LinearTravelSchema.describe("Verified linear-axis travel limits and their shared length unit."),
  rotaryTravels: RotaryTravelSchema.optional().describe("Verified rotary-axis travel limits, when the machine has rotary axes."),
  spindle: SpindleSchema.describe("Verified spindle speed, power, torque, taper, and orientation limits."),
  feed: FeedSchema.describe("Verified maximum feed and acceleration limits."),
  toolChanger: ToolChangerSchema.optional().describe("Verified tool-changer type, capacity, and timing when available."),
  coolant: CoolantSchema.optional().describe("Verified coolant capabilities when they are relevant to the operation."),
  probing: ProbingSchema.optional().describe("Verified probing equipment and limits, when installed."),
  workOffsets: WorkOffsetSchema.optional().describe("Verified work-offset capacity and controller syntax support.")
}).strict();

export type MachineProfile = z.infer<typeof MachineProfileSchema>;

export const OperationForValidationSchema = z.object({
  id: z.number().int().positive().describe("Operation ID from the source job or operation record."),
  name: z.string().min(1).max(256).describe("Operation name as shown in the CAM job."),
  type: z.string().min(1).max(64).describe("Operation family, such as drilling, milling, or turning."),
  feedRate: z.object({
    value: z.number().finite().positive().describe("Programmed feed magnitude for this operation."),
    unit: z.enum(["mm/min", "in/min", "mm/rev", "in/rev"]).describe("Feed unit used by the operation value.")
  }).strict().optional().describe("Programmed feed and explicit unit, when known."),
  spindleSpeed: z.object({
    value: z.number().finite().positive().describe("Programmed spindle speed or surface-speed magnitude."),
    unit: z.enum(["rpm", "css_m_min", "css_ft_min"]).describe("rpm for fixed spindle speed or the documented CSS surface-speed unit.")
  }).strict().optional().describe("Programmed spindle speed mode and value, when known."),
  tool: z.number().int().positive().optional().describe("Assigned tool number, when known."),
  toolDiameter: z.number().finite().positive().max(1000).optional().describe("Cutting diameter in the job's declared length unit."),
  fluteCount: z.number().int().positive().max(50).optional().describe("Number of cutting flutes or edges on the assigned tool."),
  stepover: z.number().finite().nonnegative().optional().describe("Programmed lateral step between adjacent cutting passes, in the job's length unit."),
  stepdown: z.number().finite().nonnegative().optional().describe("Programmed axial depth per pass, in the job's length unit."),
  radialDoc: z.number().finite().nonnegative().optional().describe("Radial depth of cut, in the job's length unit."),
  axialDoc: z.number().finite().nonnegative().optional().describe("Axial depth of cut, in the job's length unit."),
  material: z.string().min(1).max(64).optional().describe("Workpiece material or grade, when confirmed."),
  toolMaterial: z.enum(["carbide", "hss", "cermet", "ceramic", "pcd", "cbn"]).optional().describe("Cutting-tool substrate material, when known."),
  coating: z.string().min(1).max(32).optional().describe("Cutting-tool coating designation, when known."),
  stickout: z.number().finite().nonnegative().optional().describe("Tool length extending from the holder, in the job's length unit."),
  holder: z.string().min(1).max(64).optional().describe("Holder type or assembly identifier, when known.")
}).strict();

export type OperationForValidation = z.infer<typeof OperationForValidationSchema>;

export const ValidateMachineProfileInputSchema = z.object({
  operation: OperationForValidationSchema.describe("Operation parameters and tool data to check against the machine limits."),
  profile: MachineProfileSchema.describe("Machine, controller, travel, spindle, feed, and accessory limits. Supply only verified values.")
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
