import { z } from "zod";

export const SetupSheetInputSchema = z.object({
  part: z.record(z.unknown()).optional(),
  machine: z.record(z.unknown()).optional(),
  stock: z.record(z.unknown()).optional(),
  wcs: z.record(z.unknown()).optional(),
  operations: z.array(z.record(z.unknown())).optional(),
  tools: z.array(z.record(z.unknown())).optional(),
  notes: z.array(z.string()).optional()
}).strict();
export type SetupSheetInput = z.infer<typeof SetupSheetInputSchema>;

export const SetupSheetOutputSchema = z.object({
  schema: z.literal("mastercam-mcp/setup-sheet/v1"),
  generatedAt: z.string().datetime(),
  part: z.record(z.unknown()),
  machine: z.record(z.unknown()),
  stock: z.record(z.unknown()),
  wcs: z.record(z.unknown()),
  tools: z.array(z.record(z.unknown())),
  operations: z.array(z.record(z.unknown())),
  notes: z.array(z.string()),
  review: z.object({
    status: z.literal("draft"),
    requiresApproval: z.literal(true)
  }),
  safety: z.literal("This document is evidence for review and does not prove machine safety")
}).strict();
export type SetupSheetOutput = z.infer<typeof SetupSheetOutputSchema>;

export const CompareToolDatabasesSchema = z.object({
  left: z.unknown(),
  right: z.unknown()
}).strict();
export type CompareToolDatabasesInput = z.infer<typeof CompareToolDatabasesSchema>;

export const CompareToolDatabasesOutputSchema = z.object({
  equal: z.boolean(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(z.object({
    key: z.string(),
    left: z.unknown(),
    right: z.unknown()
  })),
  unchanged: z.array(z.string()),
  leftHash: z.string(),
  rightHash: z.string()
}).strict();
export type CompareToolDatabasesOutput = z.infer<typeof CompareToolDatabasesOutputSchema>;

export const CompareNcFilesSchema = z.object({
  before: z.string(),
  after: z.string()
}).strict();
export type CompareNcFilesInput = z.infer<typeof CompareNcFilesSchema>;

export const NcChangeSchema = z.object({
  line: z.number().int().positive(),
  type: z.enum(["added", "removed", "modified"]),
  before: z.string().optional(),
  after: z.string().optional(),
  category: z.enum(["tool_change", "spindle", "feed", "rapid", "work_offset", "compensation", "coolant", "canned_cycle", "plane", "rotary", "stop", "other"]).optional()
}).strict();

export const CompareNcFilesOutputSchema = z.object({
  equal: z.boolean(),
  totalChanges: z.number().int().nonnegative(),
  displayedChanges: z.number().int().nonnegative(),
  truncated: z.boolean(),
  toolsBefore: z.array(z.number().int().positive()),
  toolsAfter: z.array(z.number().int().positive()),
  changes: z.array(NcChangeSchema),
  semanticSummary: z.object({
    toolChanges: z.number().int().nonnegative(),
    feedChanges: z.number().int().nonnegative(),
    spindleChanges: z.number().int().nonnegative(),
    rapidMoves: z.number().int().nonnegative(),
    workOffsetChanges: z.number().int().nonnegative(),
    compensationChanges: z.number().int().nonnegative(),
    coolantChanges: z.number().int().nonnegative()
  })
}).strict();
export type CompareNcFilesOutput = z.infer<typeof CompareNcFilesOutputSchema>;

export const MachineProfileSchema = z.object({
  controller: z.string().min(1),
  maxFeed: z.number().positive().optional(),
  maxFeedUnit: z.enum(["mm/min", "in/min"]).optional(),
  maxSpindleSpeed: z.number().positive().optional(),
  holderFamily: z.string().optional(),
  axisTravels: z.object({
    x: z.number().positive().optional(),
    y: z.number().positive().optional(),
    z: z.number().positive().optional()
  }).optional(),
  rotaryLimits: z.object({
    a: z.tuple([z.number(), z.number()]).optional(),
    b: z.tuple([z.number(), z.number()]).optional(),
    c: z.tuple([z.number(), z.number()]).optional()
  }).optional(),
  maxToolLength: z.number().positive().optional(),
  toolNumberRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  supportedFeedModes: z.array(z.enum(["mm/min", "in/min", "mm/rev", "in/rev"])).optional(),
  coolantCapabilities: z.array(z.string()).optional()
}).strict();

export const ValidateMachineProfileSchema = z.object({
  operation: z.record(z.unknown()),
  profile: MachineProfileSchema
}).strict();
export type ValidateMachineProfileInput = z.infer<typeof ValidateMachineProfileSchema>;

export const ValidationIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["warning", "error"]),
  message: z.string()
}).strict();

export const ValidateMachineProfileOutputSchema = z.object({
  valid: z.boolean(),
  verification: z.enum(["verified", "review_required", "fixture_only"]),
  issues: z.array(ValidationIssueSchema)
}).strict();
export type ValidateMachineProfileOutput = z.infer<typeof ValidateMachineProfileOutputSchema>;