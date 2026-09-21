import { z } from "zod";
import { OperationIdSchema, DocumentRevisionSchema } from "./common.js";

export const CollisionSchema = z.object({
  operationId: OperationIdSchema,
  type: z.enum(["tool_holder", "tool_shank", "rapid", "workpiece", "fixture", "machine"]),
  severity: z.enum(["warning", "error"]),
  position: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number()
  }).optional(),
  description: z.string()
}).strict();

export const RunSimulationSchema = z.object({
  operationIds: z.array(OperationIdSchema).min(1).optional(),
  mode: z.enum(["full", "verify", "time"]).default("full"),
  checkCollisions: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(600000).default(120000)
}).strict();
export type RunSimulationInput = z.infer<typeof RunSimulationSchema>;

export const RunSimulationOutputSchema = z.object({
  state: z.enum(["complete", "cancelled", "failed", "partial"]),
  durationSeconds: z.number().nonnegative(),
  collisions: z.array(CollisionSchema),
  warnings: z.array(z.string()),
  cycleTimeEstimate: z.number().nonnegative().optional(),
  operationsSimulated: z.number().int().nonnegative()
}).strict();
export type RunSimulationOutput = z.infer<typeof RunSimulationOutputSchema>;

export const DetectCollisionsSchema = z.object({
  operationIds: z.array(OperationIdSchema).min(1).optional(),
  checkHolder: z.boolean().default(true),
  checkRapid: z.boolean().default(true),
  checkWorkpiece: z.boolean().default(true)
}).strict();
export type DetectCollisionsInput = z.infer<typeof DetectCollisionsSchema>;

export const DetectCollisionsOutputSchema = z.object({
  collisions: z.array(CollisionSchema),
  checkedOperations: z.array(OperationIdSchema),
  durationMs: z.number().int().nonnegative()
}).strict();
export type DetectCollisionsOutput = z.infer<typeof DetectCollisionsOutputSchema>;

export const EstimateCycleTimeSchema = z.object({
  operationId: OperationIdSchema
}).strict();
export type EstimateCycleTimeInput = z.infer<typeof EstimateCycleTimeSchema>;

export const EstimateCycleTimeOutputSchema = z.object({
  operationId: OperationIdSchema,
  seconds: z.number().nonnegative(),
  confidence: z.enum(["fixture", "simulated", "measured", "unknown"]),
  breakdown: z.object({
    cutting: z.number().nonnegative().optional(),
    rapid: z.number().nonnegative().optional(),
    toolChange: z.number().nonnegative().optional(),
    other: z.number().nonnegative().optional()
  }).optional()
}).strict();
export type EstimateCycleTimeOutput = z.infer<typeof EstimateCycleTimeOutputSchema>;

export const CompareToolpathsSchema = z.object({
  operationIds: z.array(OperationIdSchema).min(2).max(2)
}).strict();
export type CompareToolpathsInput = z.infer<typeof CompareToolpathsSchema>;

export const CompareToolpathsOutputSchema = z.object({
  changed: z.boolean(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  modified: z.number().int().nonnegative()
}).strict();
export type CompareToolpathsOutput = z.infer<typeof CompareToolpathsOutputSchema>;

export const CaptureViewSchema = z.object({
  operationId: OperationIdSchema.optional(),
  view: z.enum(["iso", "top", "front", "right", "back", "left", "bottom"]).default("iso"),
  resolution: z.object({
    width: z.number().int().positive().max(1920).default(800),
    height: z.number().int().positive().max(1080).default(600)
  }).optional(),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  showTool: z.boolean().default(true),
  showStock: z.boolean().default(true),
  showFixture: z.boolean().default(false)
}).strict();
export type CaptureViewInput = z.infer<typeof CaptureViewSchema>;

export const CaptureViewOutputSchema = z.object({
  format: z.enum(["png", "jpeg", "webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  timestamp: z.string().datetime(),
  documentRevision: DocumentRevisionSchema,
  resourceUri: z.string().optional(),
  data: z.string().optional()
}).strict();
export type CaptureViewOutput = z.infer<typeof CaptureViewOutputSchema>;