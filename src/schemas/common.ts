import { z } from "zod";

export const OperationIdSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).transform(Number)
]).refine(n => n > 0, "Operation ID must be positive");

export const FeedRateSchema = z.object({
  value: z.number().finite().positive(),
  unit: z.enum(["mm/min", "in/min", "mm/rev", "in/rev"])
});

export const SpindleSpeedSchema = z.object({
  value: z.number().finite().positive(),
  unit: z.literal("rpm")
});

export const QuantitySchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1)
});

export const DocumentRevisionSchema = z.string().min(1);
export const OperationFingerprintSchema = z.string().min(1);
export const ApprovalTokenSchema = z.string().min(1);
export const TransactionIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1);

export const ProfileSchema = z.enum(["read", "core", "write", "advanced", "dev"]);

export const BaseRequestSchema = z.object({
  operationId: OperationIdSchema.optional(),
  dryRun: z.boolean().optional()
});

export const ConfirmationSchema = z.object({
  approvalToken: ApprovalTokenSchema,
  confirmed: z.literal(true)
});

export const ProgressSchema = z.object({
  progressToken: z.union([z.string(), z.number()]).optional(),
  progress: z.number().int().min(0),
  total: z.number().int().min(1),
  message: z.string()
});

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  remediation: z.string().optional()
});

export type OperationId = z.infer<typeof OperationIdSchema>;
export type FeedRate = z.infer<typeof FeedRateSchema>;
export type SpindleSpeed = z.infer<typeof SpindleSpeedSchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;
export type OperationFingerprint = z.infer<typeof OperationFingerprintSchema>;
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;
export type TransactionId = z.infer<typeof TransactionIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type ErrorResponse = z.infer<typeof ErrorSchema>;