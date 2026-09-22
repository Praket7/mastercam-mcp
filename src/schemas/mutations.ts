import { z } from "zod";
import { OperationIdSchema, OperationIdsSchema, ApprovalTokenSchema, RollbackTokenSchema, IdempotencyKeySchema } from "./common.js";
import { FeedRateSchema, SpindleSpeedSchema } from "./units.js";

/** Changes are quantity-typed: no bare ambiguous numbers (audit SAFE-01). */
export const ParameterChangesSchema = z.object({
  feedRate: FeedRateSchema.optional(),
  spindleSpeed: SpindleSpeedSchema.optional()
}).strict().refine(
  changes => changes.feedRate !== undefined || changes.spindleSpeed !== undefined,
  { message: "At least one of feedRate or spindleSpeed must be provided" }
);

export const PreviewOperationParametersSchema = z.object({
  operationId: OperationIdSchema,
  changes: ParameterChangesSchema,
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();

export const ApplyOperationParameterPreviewSchema = z.object({
  approvalToken: ApprovalTokenSchema,
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();

export const RollbackChangeSchema = z.object({
  transactionId: RollbackTokenSchema,
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();

export const RegenerateToolpathSchema = z.object({
  operationIds: OperationIdsSchema.max(200),
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();

export const UpdateStockSchema = z.object({
  dimensions: z.object({
    x: z.number().finite().positive().max(1_000_000),
    y: z.number().finite().positive().max(1_000_000),
    z: z.number().finite().positive().max(1_000_000),
    unit: z.enum(["mm", "in"])
  }).strict(),
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();

export const ChangeToolSchema = z.object({
  operationId: OperationIdSchema,
  toolNumber: z.number().int().min(1).max(2_147_483_647),
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();

export const VerifyChangeSchema = z.object({
  operationId: OperationIdSchema,
  expected: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict().refine(v => v.feedRate !== undefined || v.spindleSpeed !== undefined, "At least one expected value must be provided"),
  documentRevision: z.string().min(1).max(128).optional()
}).strict();

export const verifyChangeOutputSchema = z.object({
  pass: z.boolean(),
  operationId: z.number(),
  checks: z.record(z.unknown()),
  reread: z.boolean(),
  documentRevision: z.string(),
  verification: z.string()
});

export const previewOperationParametersOutputSchema = z.object({
  operationId: z.number(),
  before: z.unknown(),
  after: z.unknown(),
  risks: z.array(z.string()),
  requiresRegeneration: z.boolean(),
  approvalToken: z.string(),
  expiresAt: z.string(),
  documentRevision: z.string(),
  operationFingerprint: z.string()
});

export const applyOperationParameterPreviewOutputSchema = z.object({
  applied: z.boolean(),
  operationId: z.number(),
  before: z.unknown(),
  after: z.unknown(),
  requiresRegeneration: z.boolean(),
  transactionId: z.string(),
  rollback: z.object({
    transactionId: z.string(),
    expiresAt: z.string()
  }),
  documentRevision: z.string(),
  operationFingerprint: z.string(),
  duplicate: z.boolean().optional()
});

export const rollbackChangeOutputSchema = z.object({
  applied: z.boolean(),
  operationId: z.number(),
  restored: z.unknown(),
  transactionId: z.string(),
  rollbackOf: z.string(),
  documentRevision: z.string()
});
