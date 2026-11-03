import * as z from "zod/v4";
import { OperationIdSchema, OperationIdsSchema, ApprovalTokenSchema, RollbackTokenSchema, IdempotencyKeySchema } from "./common.js";
import { FeedRateSchema, SpindleSpeedSchema } from "./units.js";

/** Changes are quantity-typed: no bare ambiguous numbers (audit SAFE-01). */
export const ParameterChangesSchema = z.object({
  feedRate: FeedRateSchema.optional().describe("New feed value with its unit, such as mm/min or in/min."),
  spindleSpeed: SpindleSpeedSchema.optional().describe("New spindle value with its unit, such as rpm or surface speed.")
}).strict().refine(
  changes => changes.feedRate !== undefined || changes.spindleSpeed !== undefined,
  { message: "At least one of feedRate or spindleSpeed must be provided" }
);

export const PreviewOperationParametersSchema = z.object({
  operationId: OperationIdSchema.describe("Exact operation ID to preview. No default or nearest-match target is used."),
  changes: ParameterChangesSchema.describe("Feed and/or spindle values to preview. At least one change is required."),
  idempotencyKey: IdempotencyKeySchema.optional().describe("Optional stable key to safely retry this preview request.")
}).strict();

export const ApplyOperationParameterPreviewSchema = z.object({
  approvalToken: ApprovalTokenSchema.describe("Single-use token returned by the exact preview after the MCP client receives operator approval."),
  idempotencyKey: IdempotencyKeySchema.optional().describe("Optional stable key to safely retry an interrupted apply request.")
}).strict();

export const RollbackChangeSchema = z.object({
  transactionId: RollbackTokenSchema.describe("Server-issued transaction ID returned by a successful apply. Caller-supplied values are rejected."),
  idempotencyKey: IdempotencyKeySchema.optional().describe("Optional stable key to safely retry a rollback request.")
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
  operationId: OperationIdSchema.describe("Exact operation ID to reread after a change."),
  expected: z.object({
    feedRate: FeedRateSchema.optional().describe("Expected feed value and unit after the change."),
    spindleSpeed: SpindleSpeedSchema.optional().describe("Expected spindle value and unit after the change.")
  }).strict().refine(v => v.feedRate !== undefined || v.spindleSpeed !== undefined, "At least one expected value must be provided").describe("At least one expected feed or spindle value to compare with a fresh backend read."),
  documentRevision: z.string().min(1).max(128).optional().describe("Optional document revision captured by the preview/apply workflow; verification fails if the document changed."),
  transactionId: RollbackTokenSchema.optional().describe("Optional transaction ID to link this verification result to the applied change.")
}).strict();

export const verifyChangeOutputSchema = z.object({
  pass: z.boolean(),
  operationId: z.number(),
  checks: z.record(z.string(), z.unknown()),
  reread: z.boolean(),
  documentRevision: z.string(),
  verification: z.string(),
  transactionId: z.string().optional()
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
