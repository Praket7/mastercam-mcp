import * as z from "zod/v4";
import * as inspection from "./schemas/inspection.js";
import * as mutations from "./schemas/mutations.js";
import * as machine from "./schemas/machine.js";
import { emptySchema } from "./schemas/common.js";
import {
  ManufacturingPreflightSchema,
  PostRegressionSchema,
  RegenerationImpactSchema
} from "./manufacturing-intelligence.js";
import {
  AnalyzeCycleTimeSchema,
  AnalyzeToolpathRiskSchema,
  CalculateThreadTapSchema,
  GenerateOperationPacketSchema,
  PlanOdRoughFinishSchema,
  RecommendJobToolingSchema
} from "./job-intelligence.js";
import type { CapabilityTier } from "./contracts.js";
import { AnalyzeNcProgramSchema } from "./nc-program.js";

export type ManifestCategory = "read" | "preview" | "write" | "advanced" | "forbidden";

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: ManifestCategory;
  inputSchema: z.ZodType;
  /** Schema for the inner data field. Registry wraps this in the standard envelope. */
  outputDataSchema?: z.ZodType;
  registered: boolean;
  mockSupport: boolean;
  legacySupport: boolean;
  mc2027Support: boolean;
  requiresExactTarget: boolean;
  requiresApproval: boolean;
  requiresRegeneration: boolean;
  idempotent: boolean;
  tier: CapabilityTier;
  tierEvidence: string;
}

interface ToolOptions {
  outputDataSchema?: z.ZodType;
  registered?: boolean;
  mockSupport?: boolean;
  legacySupport?: boolean;
  mc2027Support?: boolean;
  requiresExactTarget?: boolean;
  requiresApproval?: boolean;
  requiresRegeneration?: boolean;
  idempotent?: boolean;
  tier?: CapabilityTier;
  tierEvidence?: string;
}

function defineTool(
  name: string,
  description: string,
  category: ManifestCategory,
  inputSchema: z.ZodType,
  options: ToolOptions = {}
): ToolManifestEntry {
  const registered = options.registered ?? category !== "forbidden";
  const liveEnvironment = name === "mastercam_status" || name === "mastercam_capabilities";
  return {
    name,
    description,
    category,
    inputSchema,
    ...(options.outputDataSchema ? { outputDataSchema: options.outputDataSchema } : {}),
    registered,
    mockSupport: options.mockSupport ?? registered,
    legacySupport: options.legacySupport ?? liveEnvironment,
    mc2027Support: options.mc2027Support ?? liveEnvironment,
    requiresExactTarget: options.requiresExactTarget ?? false,
    requiresApproval: options.requiresApproval ?? category === "write",
    requiresRegeneration: options.requiresRegeneration ?? false,
    idempotent: options.idempotent ?? category === "read",
    tier: options.tier ?? (registered ? "IMPLEMENTED" : "UNAVAILABLE"),
    tierEvidence: options.tierEvidence ?? (
      liveEnvironment
        ? "Native environment adapter is implemented; LIVE_* verification requires a licensed acceptance run."
        : registered
          ? "TypeScript/fixture implementation exists; no live Mastercam mapping is advertised until a release adapter declares it."
          : "Deliberately unavailable by safety policy."
    )
  };
}

const read = (
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: ToolOptions = {}
) => defineTool(name, description, "read", inputSchema, { idempotent: true, ...options });

const preview = (
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: ToolOptions = {}
) => defineTool(name, description, "preview", inputSchema, { idempotent: false, ...options });

const write = (
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: ToolOptions = {}
) => defineTool(name, description, "write", inputSchema, { requiresApproval: true, idempotent: false, ...options });

const advanced = (
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: ToolOptions = {}
) => defineTool(name, description, "advanced", inputSchema, { idempotent: false, ...options });

const forbidden = (name: string, reason: string) => defineTool(
  name,
  reason,
  "forbidden",
  emptySchema,
  {
    registered: false,
    mockSupport: false,
    legacySupport: false,
    mc2027Support: false,
    tier: "UNAVAILABLE",
    tierEvidence: reason
  }
);

export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  read("mastercam_status", "Report live Mastercam connection status and adapter identity", inspection.mastercamStatusSchema, { outputDataSchema: inspection.mastercamStatusOutputSchema }),
  read("mastercam_capabilities", "Report which capabilities the active backend genuinely supports", inspection.mastercamCapabilitiesSchema, { outputDataSchema: inspection.mastercamCapabilitiesOutputSchema }),
  read("mastercam_help", "Explain the available Mastercam MCP tools and safety levels", inspection.mastercamHelpSchema),
  read("list_tool_categories", "List tools by read, preview, write, advanced, and forbidden category", inspection.listToolCategoriesSchema),
  read("discover_capabilities", "Show available capabilities grouped by workflow stage", inspection.discoverCapabilitiesSchema),
  read("get_compatibility_matrix", "Show supported Mastercam releases and verification status", inspection.getCompatibilityMatrixSchema),
  read("mastercam_plan", "Create a safe inspect, preview, approve, apply, verify plan", inspection.mastercamHelpSchema),
  read("mastercam_doctor", "Check local prerequisites, configuration, and bridge readiness", inspection.mastercamDoctorSchema),
  read("get_version_report", "Report detected Mastercam and NET-Hook compatibility", inspection.getVersionReportSchema),
  read("client_setup_check", "Validate client configuration readiness", inspection.clientSetupCheckSchema),
  read("get_fixture_info", "Describe the active fixture backend and its limitations", inspection.getFixtureInfoSchema),
  read("get_audit_history", "Describe the append-only audit log and current document revision", inspection.getAuditHistorySchema),

  read("get_active_part", "Inspect the active Mastercam part document", inspection.getActivePartSchema, { outputDataSchema: inspection.getActivePartOutputSchema }),
  read("get_geometry_summary", "Summarize geometry counts and bounding box without dumping entities", inspection.getGeometrySummarySchema),
  read("get_selection", "Report currently selected operations", inspection.getSelectionSchema),
  read("get_selected_entities", "Report selected entities grouped by type", inspection.getSelectedEntitiesSchema),
  read("list_machine_groups", "List machine groups in the document", inspection.listMachineGroupsSchema),
  read("get_machine_groups", "List machine groups (alias of list_machine_groups)", inspection.getMachineGroupsSchema),
  read("get_machine_context", "Return machine, stock, workholding, and coordinate context", inspection.getMachineContextSchema),
  read("get_stock", "Report stock definition and units", inspection.getStockSchema),
  read("get_wcs", "Report the active work coordinate system", inspection.getWcsSchema),
  read("get_post_processor", "Report the assigned post processor metadata", inspection.getPostProcessorSchema),
  read("get_programming_context", "Bounded live/fixture context bundle with operations, referenced tools, revision, coverage, and explicit unknowns", inspection.getProgrammingContextSchema, {
    legacySupport: false,
    mc2027Support: true,
    tier: "IMPLEMENTED",
    tierEvidence: "Mastercam 2027 Stage-B reader is implemented behind MASTERCAM_MCP_ENABLE_STAGE_B_READS=1 using runtime-probed SearchManager.GetOperations(); licensed LIVE_READ_VERIFIED acceptance is still required."
  }),

  read("list_operations", "List operations with explicit quantities and pagination", inspection.listOperationsSchema, { outputDataSchema: inspection.listOperationsOutputSchema, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B derives this read from the runtime-probed programming snapshot; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_operation", "Retrieve one operation by exact id; no fallback targeting", inspection.getOperationSchema, { outputDataSchema: inspection.getOperationOutputSchema, requiresExactTarget: true, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B requires stable unique numeric operation IDs from the runtime snapshot and fails closed otherwise; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_operation_parameters", "Retrieve one operation's proven parameters by exact id", inspection.getOperationParametersSchema, { outputDataSchema: inspection.getOperationParametersOutputSchema, requiresExactTarget: true, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B returns only runtime-reflected fields with mapping evidence and marks the parameter set partial; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("find_operations", "Search operations by name, type, or tool number", inspection.findOperationsSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B derives search results from the bounded programming snapshot; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("explain_operation", "Explain an operation from its actual returned parameters", inspection.explainOperationSchema, { requiresExactTarget: true }),
  read("get_operation_risks", "Report verification scope and concrete risks for an operation", inspection.getOperationRisksSchema, { requiresExactTarget: true }),
  read("get_dirty_toolpaths", "List operations whose mapped dirty state requires regeneration and preserve unknown state", inspection.getDirtyToolpathsSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B reports dirty state only when a runtime member is mapped; unknown state is never treated as current. Licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_toolpath_status", "Report mapped toolpath dirty/current/unknown state for an operation", inspection.getToolpathStatusSchema, { requiresExactTarget: true, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B derives status from a mapped dirty/regeneration member and returns unknown when no member is proven; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("estimate_cycle_time", "Estimate cycle time for selected operations", inspection.estimateCycleTimeSchema),
  read("compare_toolpaths", "Compare two operations' toolpaths", inspection.compareToolpathsSchema),

  read("list_tools", "List tools referenced by active operations; does not claim complete library coverage", inspection.listToolsSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B extracts referenced tool records from active operation objects. Complete .TOOLDB/library coverage is not claimed; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_tool", "Retrieve one referenced active-operation tool by id, number, or exact name", inspection.getToolSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B searches only the tools proven reachable from active operations; complete tool-library coverage is not claimed. Licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("capture_view", "Capture a bounded view image of the Mastercam graphics window", inspection.captureViewSchema),

  read("inspect", "Inspect a target and return its current values", inspection.inspectSchema, { requiresExactTarget: true }),
  read("measure", "Measure one named value on a Mastercam target", inspection.measureSchema, { requiresExactTarget: true }),
  read("verify_change", "Reread an operation and verify expected feed/spindle values", mutations.VerifyChangeSchema, { outputDataSchema: mutations.verifyChangeOutputSchema, requiresExactTarget: true }),
  read("assert", "Verify that a measured value matches an expected value", inspection.assertSchema, { requiresExactTarget: true }),

  read("generate_setup_sheet", "Create a revision-ready setup sheet from inspection data", inspection.GenerateSetupSheetSchema),
  read("compare_tool_databases", "Compare two tool database snapshots semantically", inspection.CompareToolDatabasesSchema),
  read("compare_nc_files", "Compare two NC files with sequence diffing and semantic summary", z.object(inspection.compareNcFilesInput).strict()),
  read("validate_machine_profile", "Validate an operation against a declared machine profile", inspection.ValidateMachineProfileSchema, { outputDataSchema: machine.ValidateMachineProfileOutputSchema }),
  read("manufacturing_preflight", "Run deterministic programming preflight and return blockers, warnings, unknowns, and evidence without claiming machine safety", ManufacturingPreflightSchema),
  read("analyze_regeneration_impact", "Trace direct and transitive operation dependencies affected by a programming change", RegenerationImpactSchema),
  read("analyze_post_regression", "Risk-rank semantic NC changes against an approved baseline for human review", PostRegressionSchema),
  read("recommend_job_tooling", "Rank supplied shop or ISO 13399 catalog tool records against grounded job features and material", RecommendJobToolingSchema),
  read("analyze_toolpath_risk", "Check supplied toolpath segments for travel, rapid, fixture-envelope, limit, and approach-angle risks", AnalyzeToolpathRiskSchema),
  read("analyze_nc_program", "Parse bounded linear and planar G-code arc motion; flag risky rapids, feed/spindle limits, unsupported motion, and reviewable cycle-time evidence", AnalyzeNcProgramSchema),
  read("analyze_cycle_time", "Decompose supplied motion/events into cutting and non-cutting time and identify reviewable air-time opportunities", AnalyzeCycleTimeSchema),
  read("generate_operation_packet", "Generate setup and operation notes from the supplied operation tree and tool records", GenerateOperationPacketSchema),
  read("calculate_thread_tap", "Calculate grounded metric or unified thread/tapping geometry, tap drill, RPM, and feed from supplied geometry", CalculateThreadTapSchema),
  preview("plan_od_rough_finish", "Create a non-executable rough-plus-finish OD turning plan using supplied or configured catalog and active-job tools", PlanOdRoughFinishSchema),

  preview("preview_operation_parameters", "Preview a feed/spindle change and receive a single-use approval token", mutations.PreviewOperationParametersSchema, { outputDataSchema: mutations.previewOperationParametersOutputSchema, requiresExactTarget: true }),
  write("apply_operation_parameter_preview", "Apply a previewed change using its approval token; refuses stale state", mutations.ApplyOperationParameterPreviewSchema, { outputDataSchema: mutations.applyOperationParameterPreviewOutputSchema, requiresRegeneration: true }),
  write("rollback_change", "Roll back an applied transaction using its server-held receipt", mutations.RollbackChangeSchema, { outputDataSchema: mutations.rollbackChangeOutputSchema }),
  write("change_tool", "Change the tool assigned to one operation", mutations.ChangeToolSchema, {
    registered: false,
    mockSupport: false,
    legacySupport: false,
    mc2027Support: false,
    requiresExactTarget: true,
    requiresRegeneration: true,
    tier: "UNAVAILABLE",
    tierEvidence: "Direct tool-change mutation is not exposed until it has a preview/approval workflow and a verified backend mapping."
  }),
  write("regenerate_toolpath", "Regenerate specific operations by exact id", mutations.RegenerateToolpathSchema, {
    registered: false,
    mockSupport: false,
    legacySupport: false,
    mc2027Support: false,
    requiresExactTarget: true,
    tier: "UNAVAILABLE",
    tierEvidence: "Regeneration is withheld until it is transaction-bound to the exact approved change instead of accepting operation ids alone."
  }),
  write("update_stock", "Update stock dimensions with explicit units", mutations.UpdateStockSchema, {
    registered: false,
    mockSupport: false,
    legacySupport: false,
    mc2027Support: false,
    requiresRegeneration: true,
    tier: "UNAVAILABLE",
    tierEvidence: "Direct stock mutation is not exposed until it has a preview/approval workflow and a verified backend mapping."
  }),

  advanced("run_simulation", "Run Mastercam simulation and return provenance-tagged evidence", emptySchema),
  advanced("detect_collisions", "Run collision detection for selected operations", emptySchema),

  forbidden("post_program", "NC release is intentionally outside project scope for safety"),
  forbidden("cycle_start", "Machine execution is intentionally outside project scope for safety"),
  forbidden("send_dnc", "Direct machine communication is intentionally outside project scope for safety"),
  forbidden("execute_script", "Arbitrary execution is intentionally outside project scope for safety")
];

const BY_NAME = new Map(TOOL_MANIFEST.map(entry => [entry.name, entry]));

export function manifestEntry(name: string): ToolManifestEntry | undefined {
  return BY_NAME.get(name);
}

export function tierForTool(name: string): CapabilityTier {
  return manifestEntry(name)?.tier ?? "UNAVAILABLE";
}

export function riskForTool(name: string): "read" | "preview" | "mutation" | "advanced" {
  const category = manifestEntry(name)?.category;
  if (category === "write") return "mutation";
  if (category === "preview") return "preview";
  if (category === "advanced" || category === "forbidden") return "advanced";
  return "read";
}

export function requiresApprovalForTool(name: string): boolean {
  return manifestEntry(name)?.requiresApproval ?? false;
}

export function requiresExactTargetForTool(name: string): boolean {
  return manifestEntry(name)?.requiresExactTarget ?? false;
}
