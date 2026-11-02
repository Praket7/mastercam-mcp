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
  CycleTimeToolSchema,
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
  read("get_server_readiness", "Check local prerequisites, Mastercam connection, supported features, compatibility, and write-protection state in one report. Use this instead of combining the separate doctor, version, and connection checks.", inspection.getServerReadinessSchema, { outputDataSchema: inspection.getServerReadinessOutputSchema }),
  read("get_job_context", "Gather selected part, geometry, machine, stock, work coordinate system, post, operations, and referenced tools in one bounded report. Each section returns its source and availability; missing data is never filled in with guessed values.", inspection.getJobContextSchema, {
    outputDataSchema: inspection.getJobContextOutputSchema,
    legacySupport: false,
    mc2027Support: true,
    tier: "IMPLEMENTED",
    tierEvidence: "The combined reader calls bounded native section reads, with the optional Mastercam 2027 operation snapshot behind MASTERCAM_MCP_ENABLE_STAGE_B_READS=1. Individual section availability is returned; licensed LIVE_READ_VERIFIED acceptance is still required."
  }),
  read("discover_capabilities", "List tools available in the current backend and their execution source. Filter by read, preview, write, or advanced category.", inspection.discoverCapabilitiesSchema),
  read("get_fixture_info", "Describe the active fixture backend and its limitations", inspection.getFixtureInfoSchema),
  read("get_audit_history", "Read recent redacted safety events recorded by this MCP server, with their integrity status and whether collection is enabled. It does not include actions outside this server.", inspection.getAuditHistorySchema, { outputDataSchema: inspection.getAuditHistoryOutputSchema }),

  read("get_selection", "Report currently selected operations", inspection.getSelectionSchema),
  read("get_selected_entities", "Report selected entities grouped by type", inspection.getSelectedEntitiesSchema),
  read("list_machine_groups", "List machine groups in the document", inspection.listMachineGroupsSchema),

  read("list_operations", "List operations in document order with pagination and an optional type filter. Use find_operations when you have a name or tool-number criterion.", inspection.listOperationsSchema, { outputDataSchema: inspection.listOperationsOutputSchema, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B derives this read from the runtime-probed programming snapshot; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_operation", "Retrieve one operation's mapped summary by exact ID, including its revision and fingerprint. No name or nearest-match fallback is used; use find_operations when the ID is unknown.", inspection.getOperationSchema, { outputDataSchema: inspection.getOperationOutputSchema, requiresExactTarget: true, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B requires stable unique numeric operation IDs from the runtime snapshot and fails closed otherwise; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_operation_parameters", "Retrieve only the parameters proven readable for one exact operation ID. The returned mapping may be partial; use get_operation for the compact operation summary.", inspection.getOperationParametersSchema, { outputDataSchema: inspection.getOperationParametersOutputSchema, requiresExactTarget: true, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B returns only runtime-reflected fields with mapping evidence and marks the parameter set partial; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("find_operations", "Search operations by name text, operation type, or assigned tool number. Use list_operations when you need an unfiltered paginated listing.", inspection.findOperationsSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B derives search results from the bounded programming snapshot; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("explain_operation", "Explain an operation from its actual returned parameters", inspection.explainOperationSchema, { requiresExactTarget: true }),
  read("get_operation_risks", "Report verification scope and concrete risks for an operation", inspection.getOperationRisksSchema, { requiresExactTarget: true }),
  read("get_dirty_toolpaths", "List operations whose mapped dirty state requires regeneration and preserve unknown state", inspection.getDirtyToolpathsSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B reports dirty state only when a runtime member is mapped; unknown state is never treated as current. Licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_toolpath_status", "Report mapped toolpath dirty/current/unknown state for an operation", inspection.getToolpathStatusSchema, { requiresExactTarget: true, legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B derives status from a mapped dirty/regeneration member and returns unknown when no member is proven; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("compare_toolpaths", "Compare two operations' toolpaths", inspection.compareToolpathsSchema),

  read("list_tools", "List tool records referenced by active operations. This is not a complete shop library or proprietary .TOOLDB reader; use the configured catalog for broader tooling recommendations.", inspection.listToolsSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B extracts referenced tool records from active operation objects. Complete .TOOLDB/library coverage is not claimed; licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("get_tool", "Retrieve one tool referenced by the active job using its exact ID, number, or unique name. Use list_tools for the job's referenced tool list.", inspection.getToolSchema, { legacySupport: false, mc2027Support: true, tier: "IMPLEMENTED", tierEvidence: "Stage-B searches only the tools proven reachable from active operations; complete tool-library coverage is not claimed. Licensed LIVE_READ_VERIFIED acceptance is still required." }),
  read("capture_view", "Capture a bounded view image of the Mastercam graphics window", inspection.captureViewSchema),

  read("verify_change", "Reread one exact operation and compare its current feed and spindle values with expected values after an approved change. It does not verify toolpath regeneration or machine safety.", mutations.VerifyChangeSchema, { outputDataSchema: mutations.verifyChangeOutputSchema, requiresExactTarget: true }),

  read("generate_setup_sheet", "Create a draft setup sheet from data supplied to this call. Omitted sections remain blank; use get_job_context first to gather available job data.", inspection.GenerateSetupSheetSchema),
  read("compare_tool_databases", "Compare two tool database snapshots semantically", inspection.CompareToolDatabasesSchema),
  read("compare_nc_files", "Compare two supplied NC programs by sequence and supported modal changes. This is static review and does not replace a controller-specific simulation.", z.object(inspection.compareNcFilesInput).strict()),
  read("validate_machine_profile", "Validate an operation against a declared machine profile", inspection.ValidateMachineProfileSchema, { outputDataSchema: machine.ValidateMachineProfileOutputSchema }),
  read("manufacturing_preflight", "Run deterministic programming preflight and return blockers, warnings, unknowns, and evidence without claiming machine safety", ManufacturingPreflightSchema),
  read("analyze_regeneration_impact", "Trace direct and transitive operation dependencies affected by a programming change", RegenerationImpactSchema),
  read("analyze_post_regression", "Risk-rank semantic NC changes against an approved baseline for human review", PostRegressionSchema),
  read("recommend_job_tooling", "Rank supplied shop or ISO 13399 catalog tool records against grounded job features and material", RecommendJobToolingSchema),
  read("analyze_toolpath_risk", "Review supplied toolpath segments for travel limits, rapid moves, fixture-envelope proximity, and approach angles. Supply the machine and fixture limits; unknown limits are not assumed safe.", AnalyzeToolpathRiskSchema),
  read("analyze_nc_program", "Review supported linear and planar arc G-code for over-travel, rapid, feed, and spindle risks. Unsupported motion is returned as unknown; this static parser does not simulate the controller.", AnalyzeNcProgramSchema),
  read("analyze_cycle_time", "Estimate cycle time from supplied motion events, or request a backend estimate for active operations when that backend supports it. Fixture estimates are synthetic; current native adapters do not provide cycle-time estimates. Unsupported or missing motion stays unknown.", CycleTimeToolSchema),
  read("generate_operation_packet", "Generate setup and operation notes from the supplied operation tree and tool records", GenerateOperationPacketSchema),
  read("calculate_thread_tap", "Calculate metric or unified thread and tapping guidance from explicit part dimensions and callouts. It does not extract thread features from CAD or replace the insert and tap-maker data.", CalculateThreadTapSchema),
  preview("plan_od_rough_finish", "Draft a non-executable OD roughing and finishing plan from the supplied profile, material, machine limits, and available tool records. It does not create a Mastercam operation or posted code.", PlanOdRoughFinishSchema),

  preview("preview_operation_parameters", "Preview a feed or spindle edit on one exact operation and return a short-lived, single-use approval token. This step does not change the Mastercam document.", mutations.PreviewOperationParametersSchema, { outputDataSchema: mutations.previewOperationParametersOutputSchema, requiresExactTarget: true }),
  write("apply_operation_parameter_preview", "Apply only the exact, current preview identified by approvalToken after the connected MCP client obtains operator approval. Stale or mismatched previews are refused.", mutations.ApplyOperationParameterPreviewSchema, { outputDataSchema: mutations.applyOperationParameterPreviewOutputSchema, requiresRegeneration: true }),
  write("rollback_change", "Roll back one applied transaction using its server-issued transactionId. The operation must still match the recorded post-change state.", mutations.RollbackChangeSchema, { outputDataSchema: mutations.rollbackChangeOutputSchema }),
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

/** Small default catalog for general-purpose agents; set MASTERCAM_MCP_TOOLSET=full for specialist tools. */
export const COMPACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_server_readiness", "get_job_context", "get_audit_history",
  "list_operations", "find_operations", "get_operation", "list_tools", "get_tool",
  "compare_toolpaths", "preview_operation_parameters", "apply_operation_parameter_preview",
  "verify_change", "rollback_change", "generate_setup_sheet", "compare_nc_files",
  "manufacturing_preflight", "analyze_regeneration_impact", "analyze_post_regression",
  "recommend_job_tooling", "analyze_toolpath_risk", "analyze_nc_program", "analyze_cycle_time",
  "calculate_thread_tap", "plan_od_rough_finish"
]);

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
