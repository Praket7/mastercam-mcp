import { z } from "zod";
import * as inspection from "../schemas/inspection.js";
import * as mutations from "../schemas/mutations.js";
import { emptySchema } from "../schemas/common.js";
import { categoryOf } from "../contracts.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  annotations: ToolAnnotations;
}

/** Standard result envelope every tool returns through structuredContent. */
export const ToolEnvelopeSchema = z.object({
  ok: z.boolean(),
  tool: z.string(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    remediation: z.string().optional()
  }).optional(),
  receipt: z.unknown().optional(),
  live: z.boolean().optional(),
  documentRevision: z.string().optional(),
  operationFingerprint: z.string().optional()
});

const readAnnotations: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const previewAnnotations: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false };
const mutationAnnotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
const advancedAnnotations: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false };

function tool(name: string, description: string, inputSchema: z.ZodTypeAny, annotations: ToolAnnotations, outputSchema?: z.ZodTypeAny): ToolDefinition {
  return { name, description, inputSchema, annotations, ...(outputSchema ? { outputSchema } : {}) };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // environment
  tool("mastercam_status", "Report live Mastercam connection status and adapter identity", inspection.mastercamStatusSchema, readAnnotations),
  tool("mastercam_capabilities", "Report which capabilities the active backend genuinely supports", inspection.mastercamCapabilitiesSchema, readAnnotations),
  tool("mastercam_help", "Explain the available Mastercam MCP tools and safety levels", inspection.mastercamHelpSchema, readAnnotations),
  tool("list_tool_categories", "List tools by read, preview, write, advanced, and forbidden category", inspection.listToolCategoriesSchema, readAnnotations),
  tool("discover_capabilities", "Show available capabilities grouped by workflow stage", inspection.discoverCapabilitiesSchema, readAnnotations),
  tool("get_compatibility_matrix", "Show supported Mastercam releases and verification status", inspection.getCompatibilityMatrixSchema, readAnnotations),
  tool("mastercam_plan", "Create a safe inspect, preview, approve, apply, verify plan", inspection.mastercamHelpSchema, readAnnotations),
  tool("mastercam_doctor", "Check local prerequisites, configuration, and bridge readiness", inspection.mastercamDoctorSchema, readAnnotations),
  tool("get_version_report", "Report detected Mastercam and NET-Hook compatibility", inspection.getVersionReportSchema, readAnnotations),
  tool("client_setup_check", "Validate client configuration readiness", inspection.clientSetupCheckSchema, readAnnotations),
  tool("get_fixture_info", "Describe the active fixture backend and its limitations", inspection.getFixtureInfoSchema, readAnnotations),
  tool("get_audit_history", "Describe the append-only audit log and current document revision", inspection.getAuditHistorySchema, readAnnotations),

  // document inspection
  tool("get_active_part", "Inspect the active Mastercam part document", inspection.getActivePartSchema, readAnnotations),
  tool("get_geometry_summary", "Summarize geometry counts and bounding box without dumping entities", inspection.getGeometrySummarySchema, readAnnotations),
  tool("get_selection", "Report currently selected operations", inspection.getSelectionSchema, readAnnotations),
  tool("get_selected_entities", "Report selected entities grouped by type", inspection.getSelectedEntitiesSchema, readAnnotations),
  tool("list_machine_groups", "List machine groups in the document", inspection.listMachineGroupsSchema, readAnnotations),
  tool("get_machine_groups", "List machine groups (alias of list_machine_groups)", inspection.getMachineGroupsSchema, readAnnotations),
  tool("get_machine_context", "Return machine, stock, workholding, and coordinate context", inspection.getMachineContextSchema, readAnnotations),
  tool("get_stock", "Report stock definition and units", inspection.getStockSchema, readAnnotations),
  tool("get_wcs", "Report the active work coordinate system", inspection.getWcsSchema, readAnnotations),
  tool("get_post_processor", "Report the assigned post processor metadata", inspection.getPostProcessorSchema, readAnnotations),
  tool("get_programming_context", "Bounded single-call context bundle: part, machine, stock, tools, operations, dirty state", inspection.getProgrammingContextSchema, readAnnotations),

  // operations
  tool("list_operations", "List operations with explicit quantities and pagination", inspection.listOperationsSchema, readAnnotations),
  tool("get_operation", "Retrieve one operation by exact id; no fallback targeting", inspection.getOperationSchema, readAnnotations),
  tool("get_operation_parameters", "Retrieve one operation's parameters by exact id", inspection.getOperationParametersSchema, readAnnotations),
  tool("find_operations", "Search operations by name, type, or tool number", inspection.findOperationsSchema, readAnnotations),
  tool("explain_operation", "Explain an operation from its actual returned parameters", inspection.explainOperationSchema, readAnnotations),
  tool("get_operation_risks", "Report verification scope and concrete risks for an operation", inspection.getOperationRisksSchema, readAnnotations),
  tool("get_dirty_toolpaths", "List operations whose toolpaths need regeneration", inspection.getDirtyToolpathsSchema, readAnnotations),
  tool("get_toolpath_status", "Report toolpath generation state for an operation", inspection.getToolpathStatusSchema, readAnnotations),
  tool("estimate_cycle_time", "Estimate cycle time for selected operations", inspection.estimateCycleTimeSchema, readAnnotations),
  tool("compare_toolpaths", "Compare two operations' toolpaths", inspection.compareToolpathsSchema, readAnnotations),

  // tools
  tool("list_tools", "List cutting tools with units", inspection.listToolsSchema, readAnnotations),
  tool("get_tool", "Retrieve one tool by id or number", inspection.getToolSchema, readAnnotations),

  // visual
  tool("capture_view", "Capture a bounded view image of the Mastercam graphics window", inspection.captureViewSchema, readAnnotations),

  // targeting helpers
  tool("inspect", "Inspect a target and return its current values", inspection.inspectSchema, readAnnotations),
  tool("measure", "Measure one named value on a Mastercam target", inspection.measureSchema, readAnnotations),
  tool("verify_change", "Reread an operation and verify an expected feed or speed value (requires exact operationId and quantity)", mutations.VerifyChangeSchema, readAnnotations),
  tool("assert", "Verify that a measured value matches an expected value", inspection.assertSchema, readAnnotations),

  // shop floor
  tool("generate_setup_sheet", "Create a revision-ready setup sheet from inspection data", inspection.GenerateSetupSheetSchema, readAnnotations),
  tool("compare_tool_databases", "Compare two tool database snapshots semantically", inspection.CompareToolDatabasesSchema, readAnnotations),
  tool("compare_nc_files", "Compare two NC files with real sequence diffing and semantic summary", inspection.compareNcFilesInput ? z.object({ before: z.string(), after: z.string() }).strict() : emptySchema, readAnnotations),
  tool("validate_machine_profile", "Validate an operation against a declared machine profile", inspection.ValidateMachineProfileSchema, readAnnotations),

  // controlled mutation workflow
  tool("preview_operation_parameters", "Preview a feed/spindle change and receive a single-use approval token", mutations.PreviewOperationParametersSchema, previewAnnotations),
  tool("apply_operation_parameter_preview", "Apply a previewed change using its approval token; refuses stale state", mutations.ApplyOperationParameterPreviewSchema, mutationAnnotations),
  tool("rollback_change", "Roll back an applied transaction using its server-held receipt", mutations.RollbackChangeSchema, mutationAnnotations),

  // other mutations - set_feed_speed removed: use preview/apply workflow only (audit BUG-03)
  tool("change_tool", "Change the tool assigned to one operation", mutations.ChangeToolSchema, mutationAnnotations),
  tool("regenerate_toolpath", "Regenerate specific operations by exact id", mutations.RegenerateToolpathSchema, mutationAnnotations),
  tool("update_stock", "Update stock dimensions with explicit units", mutations.UpdateStockSchema, mutationAnnotations),

  // advanced
  tool("run_simulation", "Run Mastercam simulation and return provenance-tagged evidence", emptySchema, advancedAnnotations),
  tool("detect_collisions", "Run collision detection for selected operations", emptySchema, advancedAnnotations)
];

export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find(definition => definition.name === name);
}

export function annotationsFor(name: string): ToolAnnotations {
  return toolDefinition(name)?.annotations ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
}

export { categoryOf };
