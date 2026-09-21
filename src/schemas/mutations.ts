import { z } from "zod";
import { OperationIdSchema, DocumentRevisionSchema, OperationFingerprintSchema, FeedRateSchema, SpindleSpeedSchema, ApprovalTokenSchema, TransactionIdSchema, IdempotencyKeySchema } from "./common.js";

export const PreviewOperationParametersSchema = z.object({
  operationId: OperationIdSchema,
  changes: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict().refine(v => v.feedRate !== undefined || v.spindleSpeed !== undefined, "At least one of feedRate or spindleSpeed must be provided"),
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();
export type PreviewOperationParametersInput = z.infer<typeof PreviewOperationParametersSchema>;

export const PreviewOperationParametersOutputSchema = z.object({
  before: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict(),
  after: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict(),
  requiresRegeneration: z.boolean(),
  rollbackAvailable: z.boolean(),
  approvalToken: ApprovalTokenSchema,
  expiresAt: z.string().datetime(),
  documentRevision: DocumentRevisionSchema,
  operationFingerprint: OperationFingerprintSchema,
  risks: z.array(z.object({
    code: z.string(),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string()
  }))
}).strict();
export type PreviewOperationParametersOutput = z.infer<typeof PreviewOperationParametersOutputSchema>;

export const ApplyOperationParameterPreviewSchema = z.object({
  approvalToken: ApprovalTokenSchema,
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();
export type ApplyOperationParameterPreviewInput = z.infer<typeof ApplyOperationParameterPreviewSchema>;

export const ApplyOperationParameterPreviewOutputSchema = z.object({
  applied: z.boolean(),
  transactionId: TransactionIdSchema,
  documentRevision: DocumentRevisionSchema,
  operationFingerprint: OperationFingerprintSchema,
  before: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict(),
  after: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict(),
  regenerated: z.boolean(),
  verification: z.object({
    pass: z.boolean(),
    reread: z.boolean(),
    actualFeedRate: FeedRateSchema.optional(),
    actualSpindleSpeed: SpindleSpeedSchema.optional()
  })
}).strict();
export type ApplyOperationParameterPreviewOutput = z.infer<typeof ApplyOperationParameterPreviewOutputSchema>;

export const VerifyChangeSchema = z.object({
  operationId: OperationIdSchema,
  expected: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict().refine(v => v.feedRate !== undefined || v.spindleSpeed !== undefined, "At least one expected value must be provided"),
  documentRevision: DocumentRevisionSchema.optional()
}).strict();
export type VerifyChangeInput = z.infer<typeof VerifyChangeSchema>;

export const VerifyChangeOutputSchema = z.object({
  pass: z.boolean(),
  operationId: OperationIdSchema,
  expectedFeedRate: FeedRateSchema.optional(),
  actualFeedRate: FeedRateSchema.optional(),
  expectedSpindleSpeed: SpindleSpeedSchema.optional(),
  actualSpindleSpeed: SpindleSpeedSchema.optional(),
  reread: z.boolean(),
  verification: z.enum(["verified", "mismatch", "stale_revision"])
}).strict();
export type VerifyChangeOutput = z.infer<typeof VerifyChangeOutputSchema>;

export const RollbackChangeSchema = z.object({
  transactionId: TransactionIdSchema,
  idempotencyKey: IdempotencyKeySchema.optional()
}).strict();
export type RollbackChangeInput = z.infer<typeof RollbackChangeSchema>;

export const RollbackChangeOutputSchema = z.object({
  applied: z.boolean(),
  rollbackTransactionId: TransactionIdSchema,
  documentRevision: DocumentRevisionSchema,
  operationFingerprint: OperationFingerprintSchema,
  before: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict(),
  after: z.object({
    feedRate: FeedRateSchema.optional(),
    spindleSpeed: SpindleSpeedSchema.optional()
  }).strict(),
  regenerated: z.boolean(),
  verification: z.object({
    pass: z.boolean(),
    reread: z.boolean()
  })
}).strict();
export type RollbackChangeOutput = z.infer<typeof RollbackChangeOutputSchema>;

export const RegenerateToolpathSchema = z.object({
  operationIds: z.array(OperationIdSchema).min(1),
  waitForCompletion: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(300000).default(60000)
}).strict();
export type RegenerateToolpathInput = z.infer<typeof RegenerateToolpathSchema>;

export const RegenerateToolpathOutputSchema = z.object({
  operationIds: z.array(OperationIdSchema),
  regenerated: z.boolean(),
  progress: z.array(z.string()),
  durationMs: z.number().int().nonnegative()
}).strict();
export type RegenerateToolpathOutput = z.infer<typeof RegenerateToolpathOutputSchema>;