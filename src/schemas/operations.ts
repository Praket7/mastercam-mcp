import { z } from "zod";
import { OperationIdSchema, DocumentRevisionSchema, OperationFingerprintSchema, FeedRateSchema, SpindleSpeedSchema, QuantitySchema } from "./common.js";

export const OperationParameterSchema = z.object({
  feedRate: FeedRateSchema.optional(),
  spindleSpeed: SpindleSpeedSchema.optional(),
  stepdown: QuantitySchema.optional(),
  stepover: QuantitySchema.optional(),
  depth: QuantitySchema.optional(),
  leadIn: QuantitySchema.optional(),
  leadOut: QuantitySchema.optional(),
  approach: z.string().optional(),
  retract: z.string().optional()
}).strict();

export const OperationSchema = z.object({
  id: OperationIdSchema,
  name: z.string(),
  type: z.string(),
  strategy: z.string().optional(),
  feedRate: FeedRateSchema.optional(),
  spindleSpeed: SpindleSpeedSchema.optional(),
  tool: z.object({
    number: z.number().int().positive(),
    name: z.string().optional()
  }).optional(),
  parameters: OperationParameterSchema.optional(),
  wcs: z.string().optional(),
  machineGroup: z.string().optional(),
  enabled: z.boolean().optional(),
  dirty: z.boolean().optional(),
  geometryIds: z.array(z.union([z.string(), z.number()])).optional()
}).strict();

export const OperationArraySchema = z.array(OperationSchema);

export const ListOperationsSchema = z.object({
  includeDisabled: z.boolean().optional(),
  machineGroup: z.string().optional()
}).strict();
export type ListOperationsInput = z.infer<typeof ListOperationsSchema>;
export type ListOperationsOutput = z.infer<typeof OperationArraySchema>;

export const GetOperationSchema = z.object({
  operationId: OperationIdSchema
}).strict();
export type GetOperationInput = z.infer<typeof GetOperationSchema>;

export const GetOperationOutputSchema = z.object({
  operation: OperationSchema,
  documentRevision: DocumentRevisionSchema,
  operationFingerprint: OperationFingerprintSchema
}).strict();
export type GetOperationOutput = z.infer<typeof GetOperationOutputSchema>;

export const FindOperationsSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  toolNumber: z.number().int().positive().optional(),
  machineGroup: z.string().optional(),
  type: z.string().optional()
}).strict();
export type FindOperationsInput = z.infer<typeof FindOperationsSchema>;
export type FindOperationsOutput = z.infer<typeof OperationArraySchema>;

export const ExplainOperationSchema = z.object({
  operationId: OperationIdSchema
}).strict();
export type ExplainOperationInput = z.infer<typeof ExplainOperationSchema>;

export const ExplainOperationOutputSchema = z.object({
  operationId: OperationIdSchema,
  summary: z.string(),
  inputs: z.object({
    name: z.string(),
    type: z.string(),
    strategy: z.string().optional(),
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional(),
    tool: z.object({
      number: z.number().int().positive(),
      name: z.string().optional(),
      diameter: z.number().positive().optional()
    }).optional(),
    parameters: OperationParameterSchema.optional(),
    wcs: z.string().optional()
  }),
  verification: z.object({
    toolpath: z.enum(["generated", "not_generated", "dirty", "unknown"]),
    collisions: z.enum(["checked_clear", "checked_collision", "not_checked", "unknown"]),
    live: z.boolean()
  }),
  nextActions: z.array(z.string()),
  unknownFields: z.array(z.string()).optional()
}).strict();
export type ExplainOperationOutput = z.infer<typeof ExplainOperationOutputSchema>;

export const OperationRiskSchema = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "warning", "unknown", "not_applicable"]),
  message: z.string().optional()
}).strict();

export const GetOperationRisksSchema = z.object({
  operationId: OperationIdSchema
}).strict();
export type GetOperationRisksInput = z.infer<typeof GetOperationRisksSchema>;

export const GetOperationRisksOutputSchema = z.object({
  operationId: OperationIdSchema,
  riskLevel: z.enum(["low", "review_required", "high", "blocked"]),
  checks: z.array(OperationRiskSchema),
  warnings: z.array(z.string()),
  requiresConfirmation: z.boolean()
}).strict();
export type GetOperationRisksOutput = z.infer<typeof GetOperationRisksOutputSchema>;

export const GetOperationParametersSchema = z.object({
  operationId: OperationIdSchema
}).strict();
export type GetOperationParametersInput = z.infer<typeof GetOperationParametersSchema>;

export const GetOperationParametersOutputSchema = z.object({
  operationId: OperationIdSchema,
  parameters: OperationParameterSchema
}).strict();
export type GetOperationParametersOutput = z.infer<typeof GetOperationParametersOutputSchema>;