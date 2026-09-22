import * as z from "zod/v4";
import { FeedRateSchema, SpindleSpeedSchema, LengthSchema } from "./units.js";

/** Operation ids are integers in Mastercam; strings were never valid on the wire. */
export const OperationIdSchema = z.number().int().finite().min(1).max(2_147_483_647);
export type OperationId = z.infer<typeof OperationIdSchema>;

export const OperationIdsSchema = z.array(OperationIdSchema).max(1000);
export const ToolNumberSchema = z.number().int().finite().min(1).max(2_147_483_647);
export const ToolIdSchema = z.union([z.string().min(1).max(128), ToolNumberSchema]);
export const InstanceIdSchema = z.string().min(1).max(128);

export const FeedChangeSchema = FeedRateSchema;
export const SpindleChangeSchema = SpindleSpeedSchema;
export const LengthChangeSchema = LengthSchema;

export const TokenSchema = z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/, "tokens use url-safe characters");
export const ApprovalTokenSchema = TokenSchema;
export const RollbackTokenSchema = TokenSchema;
export const IdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const RevisionSchema = z.string().min(1).max(128);

export const NonEmptyText = (max = 4096) => z.string().min(1).max(max);
export const OptionalText = (max = 4096) => z.string().max(max).optional();

export const BoundedStringArray = (maxItems: number, maxLen = 4096) =>
  z.array(z.string().min(1).max(maxLen)).max(maxItems);

export const QuantityInputSchema = z.union([FeedRateSchema, SpindleSpeedSchema, LengthSchema]);

export const emptySchema = z.object({}).strict();
