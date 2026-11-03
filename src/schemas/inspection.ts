import * as z from "zod/v4";
import { OperationIdSchema, OperationIdsSchema, ToolIdSchema, BoundedStringArray, OptionalText, emptySchema } from "./common.js";
import { ValidateMachineProfileInputSchema } from "./machine.js";

const optionalOperationIds = OperationIdsSchema.optional();

export const getSelectionSchema = emptySchema;
export const listMachineGroupsSchema = emptySchema;

export const listOperationsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum operations to return, from 1 to 500."),
  offset: z.number().int().min(0).default(0).describe("Number of matching operations to skip."),
  operationType: OptionalText(64).describe("Optional case-insensitive substring filter for operation types.")
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

export const getOperationSchema = z.object({ operationId: OperationIdSchema.describe("Exact Mastercam operation ID. No name or nearest-match fallback is used.") }).strict();
export const getOperationOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  feedRate: z.unknown(),
  spindleSpeed: z.unknown(),
  tool: z.number().optional(),
  toolpathDirty: z.boolean().nullable().optional(),
  mappingEvidence: z.record(z.string(), z.string()).optional(),
  documentRevision: z.string(),
  operationFingerprint: z.string()
});
export const getOperationParametersSchema = z.object({ operationId: OperationIdSchema.describe("Exact Mastercam operation ID whose mapped parameters should be returned.") }).strict();
export const getOperationParametersOutputSchema = z.object({
  operationId: z.number(),
  parameters: z.record(z.string(), z.unknown()),
  documentRevision: z.string()
});

export const findOperationsSchema = z.object({
  query: OptionalText(256).describe("Case-insensitive substring matched against operation names or types."),
  operationType: OptionalText(64).describe("Optional case-insensitive substring filter for operation types."),
  toolNumber: z.number().int().min(1).max(2_147_483_647).optional().describe("Optional assigned tool number."),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum matches to return, from 1 to 200.")
}).strict();

export const explainOperationSchema = z.object({
  operationId: OperationIdSchema.describe("Exact operation ID to explain. Use list_operations or find_operations if you do not know it.")
}).strict();
export const getOperationRisksSchema = z.object({
  operationId: OperationIdSchema.describe("Exact operation ID whose available verification evidence and known risks should be reported.")
}).strict();

export const listToolsSchema = z.object({ limit: z.number().int().min(1).max(500).default(200).describe("Maximum referenced job tools to return, from 1 to 500. This is not a complete .TOOLDB listing.") }).strict();
export const getToolSchema = z.object({ toolId: ToolIdSchema.describe("Exact identifier, tool number, or unique name of a tool referenced by the active job.") }).strict();

export const getDirtyToolpathsSchema = z.object({
  operationIds: optionalOperationIds.describe("Optional exact operation IDs to limit the scan. Omit to inspect all mapped operations in the active document.")
}).strict();
export const getSelectedEntitiesSchema = emptySchema;

export const getToolpathStatusSchema = z.object({
  operationId: OperationIdSchema.describe("Exact operation ID whose mapped toolpath state should be checked.")
}).strict();
export const compareToolpathsSchema = z.object({
  beforeOperationId: OperationIdSchema.describe("Exact operation ID for the earlier toolpath."),
  afterOperationId: OperationIdSchema.describe("Exact operation ID for the later toolpath.")
}).strict();

export const captureViewSchema = z.object({
  width: z.number().int().min(64).max(1920).default(1024).describe("Requested image width in pixels, from 64 to 1920."),
  height: z.number().int().min(64).max(1080).default(768).describe("Requested image height in pixels, from 64 to 1080."),
  format: z.enum(["png", "jpeg"]).default("png").describe("Image encoding to return.")
}).strict();

export const getJobContextSchema = z.object({
  sections: z.array(z.enum(["part", "geometry", "machine", "stock", "wcs", "post", "operations", "tools"]))
    .min(1).max(8)
    .default(["part", "geometry", "machine", "stock", "wcs", "post", "operations", "tools"])
    .describe("Choose which context sections to gather. Each section reports unavailable data explicitly.")
}).strict();
export const getJobContextOutputSchema = z.object({
  sections: z.record(z.string(), z.object({
    status: z.enum(["available", "unavailable"]),
    sourceTool: z.string().optional(),
    live: z.boolean().optional(),
    data: z.unknown().optional(),
    documentRevision: z.string().optional(),
    error: z.unknown().optional()
  }).strict()),
  unavailable: z.array(z.string())
}).strict();

export const getServerReadinessSchema = emptySchema;
const DoctorCheckSchema = z.object({
  ok: z.boolean(),
  value: z.unknown(),
  required: z.string().optional()
}).strict();
const NativeReadResultSchema = <T extends z.ZodType>(dataSchema: T) => z.union([
  dataSchema,
  z.object({ error: z.unknown() }).strict()
]);
export const getServerReadinessOutputSchema = z.object({
  diagnostics: z.object({
    checks: z.record(z.string(), DoctorCheckSchema),
    backend: z.string(),
    installations: z.array(z.unknown()),
    compatibility: z.unknown(),
    guidance: z.string()
  }).strict(),
  connection: NativeReadResultSchema(z.object({
    connected: z.boolean(),
    backend: z.string(),
    adapter: z.string(),
    runtime: z.string(),
    mastercamVersion: z.string(),
    protocolVersion: z.number()
  })),
  capabilities: NativeReadResultSchema(z.object({
    adapterVersion: z.string(),
    mastercamVersion: z.string(),
    runtime: z.string(),
    protocol: z.string(),
    tools: z.array(z.unknown()),
    note: z.string()
  }))
}).strict();

export const discoverCapabilitiesSchema = z.object({
  category: z.enum(["read", "preview", "write", "advanced"]).optional()
    .describe("Optional tool category filter.")
}).strict();
export const getAuditHistorySchema = z.object({ limit: z.number().int().min(1).max(500).default(50).describe("Maximum recent audit entries to return, from 1 to 500.") }).strict();
export const getAuditHistoryOutputSchema = z.object({
  enabled: z.boolean(),
  integrity: z.enum(["verified", "disabled", "failed"]),
  lastSequence: z.number().int().nonnegative(),
  entries: z.array(z.record(z.string(), z.unknown())),
  error: z.string().optional()
}).strict();
export const getFixtureInfoSchema = emptySchema;
export const compareNcFilesInput = {
  before: z.string().min(1).max(2_000_000).describe("Earlier NC program text used as the comparison baseline."),
  after: z.string().min(1).max(2_000_000).describe("Later NC program text to compare with the baseline.")
} as const;

export const CompareToolDatabasesSchema = z.object({
  left: z.unknown().describe("First tool database snapshot as a JSON object or array."),
  right: z.unknown().describe("Second tool database snapshot in the same format as left.")
}).strict();

export const ValidateMachineProfileSchema = ValidateMachineProfileInputSchema;

export const GenerateSetupSheetSchema = z.object({
  part: z.record(z.string(), z.unknown()).optional().describe("Part name, drawing reference, and other confirmed part details."),
  machine: z.record(z.string(), z.unknown()).optional().describe("Confirmed machine identity and relevant machine setup details."),
  stock: z.record(z.string(), z.unknown()).optional().describe("Stock dimensions and material, including explicit units."),
  wcs: z.record(z.string(), z.unknown()).optional().describe("Work coordinate system name and verified origin details."),
  operations: z.array(z.record(z.string(), z.unknown())).max(500).optional().describe("Operation records to include. Use get_job_context first when active job data is available."),
  tools: z.array(z.record(z.string(), z.unknown())).max(500).optional().describe("Tool records referenced by the included operations."),
  notes: BoundedStringArray(100).optional().describe("Operator notes to include in the draft setup sheet.")
}).strict();

export const SHOP_TOOLS = ["generate_setup_sheet", "compare_tool_databases", "compare_nc_files", "validate_machine_profile"] as const;
