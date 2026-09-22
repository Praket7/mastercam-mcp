import * as z from "zod/v4";
import { OperationIdSchema, OperationIdsSchema, ToolIdSchema, BoundedStringArray, OptionalText, emptySchema } from "./common.js";
import { ValidateMachineProfileInputSchema } from "./machine.js";

const optionalOperationId = OperationIdSchema.optional();
const optionalOperationIds = OperationIdsSchema.optional();

export const mastercamStatusSchema = emptySchema;
export const mastercamStatusOutputSchema = z.object({
  connected: z.boolean(),
  backend: z.string(),
  adapter: z.string(),
  runtime: z.string(),
  mastercamVersion: z.string(),
  protocolVersion: z.number()
});
export const mastercamCapabilitiesSchema = z.object({ refresh: z.boolean().optional() }).strict();
export const mastercamCapabilitiesOutputSchema = z.object({
  adapterVersion: z.string(),
  mastercamVersion: z.string(),
  runtime: z.string(),
  protocol: z.string(),
  tools: z.array(z.unknown()),
  note: z.string()
});
export const getActivePartSchema = emptySchema;
export const getActivePartOutputSchema = z.object({
  name: z.string(),
  path: z.string(),
  units: z.string(),
  modified: z.boolean(),
  documentRevision: z.string()
});
export const getGeometrySummarySchema = z.object({ operationId: optionalOperationId }).strict();
export const getSelectionSchema = emptySchema;
export const listMachineGroupsSchema = emptySchema;

export const listOperationsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  operationType: OptionalText(64)
}).strict();
export const listOperationsOutputSchema = z.array(z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  feedRate: z.unknown(),
  feed: z.unknown().optional(),
  spindleSpeed: z.unknown(),
  tool: z.number().optional(),
  toolpathDirty: z.boolean().optional()
}));

export const getOperationSchema = z.object({ operationId: OperationIdSchema }).strict();
export const getOperationOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  feedRate: z.unknown(),
  spindleSpeed: z.unknown(),
  tool: z.number().optional(),
  documentRevision: z.string(),
  operationFingerprint: z.string()
});
export const getOperationParametersSchema = z.object({ operationId: OperationIdSchema }).strict();
export const getOperationParametersOutputSchema = z.object({
  operationId: z.number(),
  parameters: z.record(z.string(), z.unknown()),
  documentRevision: z.string()
});

export const findOperationsSchema = z.object({
  query: OptionalText(256),
  operationType: OptionalText(64),
  toolNumber: z.number().int().min(1).max(2_147_483_647).optional(),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();

export const explainOperationSchema = z.object({ operationId: OperationIdSchema }).strict();
export const getOperationRisksSchema = z.object({ operationId: OperationIdSchema }).strict();

export const listToolsSchema = z.object({ limit: z.number().int().min(1).max(500).default(200) }).strict();
export const getToolSchema = z.object({ toolId: ToolIdSchema }).strict();

export const getStockSchema = emptySchema;
export const getWcsSchema = emptySchema;
export const getPostProcessorSchema = emptySchema;
export const getMachineContextSchema = emptySchema;
export const getDirtyToolpathsSchema = z.object({ operationIds: optionalOperationIds }).strict();
export const getSelectedEntitiesSchema = emptySchema;

export const getToolpathStatusSchema = z.object({ operationId: OperationIdSchema }).strict();
export const estimateCycleTimeSchema = z.object({ operationIds: optionalOperationIds }).strict();
export const compareToolpathsSchema = z.object({
  beforeOperationId: OperationIdSchema,
  afterOperationId: OperationIdSchema
}).strict();

export const captureViewSchema = z.object({
  width: z.number().int().min(64).max(1920).default(1024),
  height: z.number().int().min(64).max(1080).default(768),
  format: z.enum(["png", "jpeg"]).default("png")
}).strict();

export const getProgrammingContextSchema = z.object({
  includeGeometry: z.boolean().default(false)
}).strict();

export const getVersionReportSchema = emptySchema;
export const mastercamDoctorSchema = emptySchema;
export const mastercamHelpSchema = emptySchema;
export const listToolCategoriesSchema = emptySchema;
export const discoverCapabilitiesSchema = z.object({ category: OptionalText(64) }).strict();
export const getCompatibilityMatrixSchema = emptySchema;
export const clientSetupCheckSchema = emptySchema;
export const getAuditHistorySchema = z.object({ limit: z.number().int().min(1).max(500).default(50) }).strict();
export const getFixtureInfoSchema = emptySchema;
export const getMachineGroupsSchema = listMachineGroupsSchema;

export const inspectSchema = z.object({
  operationId: OperationIdSchema,
  path: OptionalText(256)
}).strict();

export const measureSchema = z.object({
  operationId: OperationIdSchema,
  path: z.string().min(1).max(256).default("operation.feed")
}).strict();

export const assertSchema = z.object({
  operationId: OperationIdSchema,
  path: z.string().min(1).max(256).default("operation.feed"),
  equals: z.union([z.string().max(4096), z.number().finite(), z.boolean()]).optional()
}).strict();

export const compareNcFilesInput = {
  before: z.string().min(1).max(2_000_000),
  after: z.string().min(1).max(2_000_000)
} as const;

export const CompareToolDatabasesSchema = z.object({
  left: z.unknown(),
  right: z.unknown()
}).strict();

export const ValidateMachineProfileSchema = ValidateMachineProfileInputSchema;

export const GenerateSetupSheetSchema = z.object({
  part: z.record(z.string(), z.unknown()).optional(),
  machine: z.record(z.string(), z.unknown()).optional(),
  stock: z.record(z.string(), z.unknown()).optional(),
  wcs: z.record(z.string(), z.unknown()).optional(),
  operations: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  tools: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  notes: BoundedStringArray(100).optional()
}).strict();

export const SHOP_TOOLS = ["generate_setup_sheet", "compare_tool_databases", "compare_nc_files", "validate_machine_profile"] as const;
export const Bounded = { BoundedStringArray, OptionalText };
export const _internal = { optionalOperationId, optionalOperationIds, emptySchema };
