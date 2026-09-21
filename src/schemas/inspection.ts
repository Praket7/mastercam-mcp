import { z } from "zod";
import { OperationIdSchema, DocumentRevisionSchema } from "./common.js";

export const GetActivePartSchema = z.object({}).strict();
export type GetActivePartInput = z.infer<typeof GetActivePartSchema>;

export const ActivePartSchema = z.object({
  name: z.string(),
  path: z.string(),
  units: z.enum(["mm", "in", "cm"]),
  modified: z.boolean(),
  revision: DocumentRevisionSchema,
  fingerprint: z.string()
}).strict();
export type ActivePartOutput = z.infer<typeof ActivePartSchema>;

export const GeometrySummarySchema = z.object({
  solids: z.number().int().nonnegative(),
  surfaces: z.number().int().nonnegative(),
  curves: z.number().int().nonnegative(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number()
  }),
  units: z.enum(["mm", "in", "cm"])
}).strict();
export type GeometrySummaryOutput = z.infer<typeof GeometrySummarySchema>;

export const SelectionSchema = z.object({
  operationIds: z.array(OperationIdSchema),
  count: z.number().int().nonnegative(),
  entities: z.array(z.object({
    type: z.string(),
    id: z.union([z.string(), z.number()])
  })).optional()
}).strict();
export type SelectionOutput = z.infer<typeof SelectionSchema>;

export const MachineGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["mill", "lathe", "mill_turn", "router", "wire", "other"])
}).strict();

export const MachineGroupArraySchema = z.array(MachineGroupSchema);
export const ListMachineGroupsSchema = z.object({}).strict();
export type ListMachineGroupsInput = z.infer<typeof ListMachineGroupsSchema>;
export type ListMachineGroupsOutput = z.infer<typeof MachineGroupArraySchema>;

export const StockSchema = z.object({
  dimensions: z.object({
    x: z.number().positive(),
    y: z.number().positive(),
    z: z.number().positive()
  }),
  units: z.enum(["mm", "in", "cm"]),
  material: z.string().optional(),
  source: z.enum(["explicit", "inferred", "bounding_box"]).optional()
}).strict();
export type StockOutput = z.infer<typeof StockSchema>;

export const GetStockSchema = z.object({}).strict();
export type GetStockInput = z.infer<typeof GetStockSchema>;

export const WCSSchema = z.object({
  name: z.string(),
  origin: z.tuple([z.number(), z.number(), z.number()]),
  axes: z.object({
    x: z.tuple([z.number(), z.number(), z.number()]),
    y: z.tuple([z.number(), z.number(), z.number()]),
    z: z.tuple([z.number(), z.number(), z.number()])
  }),
  active: z.boolean().optional()
}).strict();
export type WCSOutput = z.infer<typeof WCSSchema>;

export const GetWcssSchema = z.object({}).strict();
export type GetWcssInput = z.infer<typeof GetWcssSchema>;

export const PostProcessorSchema = z.object({
  name: z.string(),
  extension: z.string(),
  machine: z.string(),
  version: z.string().optional()
}).strict();

export const GetPostProcessorSchema = z.object({}).strict();
export type GetPostProcessorInput = z.infer<typeof GetPostProcessorSchema>;

export const ToolSchema = z.object({
  number: z.number().int().positive(),
  name: z.string(),
  diameter: z.number().positive().optional(),
  length: z.number().positive().optional(),
  units: z.enum(["mm", "in"]),
  type: z.string().optional(),
  holder: z.string().optional(),
  fluteCount: z.number().int().positive().optional(),
  coolant: z.boolean().optional()
}).strict();

export const ToolArraySchema = z.array(ToolSchema);
export const ListToolsSchema = z.object({}).strict();
export type ListToolsInput = z.infer<typeof ListToolsSchema>;
export type ListToolsOutput = z.infer<typeof ToolArraySchema>;

export const ToolpathStatusSchema = z.object({
  operationId: OperationIdSchema,
  generated: z.boolean(),
  valid: z.boolean(),
  dirty: z.boolean(),
  collisionState: z.enum(["not_checked", "checking", "clear", "collision"]),
  lastRegenerated: z.string().datetime().optional()
}).strict();

export const GetToolpathStatusSchema = z.object({
  operationId: OperationIdSchema
}).strict();
export type GetToolpathStatusInput = z.infer<typeof GetToolpathStatusSchema>;
export type ToolpathStatusOutput = z.infer<typeof ToolpathStatusSchema>;

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