/**
 * Tools implemented entirely by the TypeScript server. They do not invoke a
 * Mastercam adapter and are therefore available in both fixture and live
 * modes. Keep this list small and explicit so live discovery cannot drift
 * into advertising unverified native mappings.
 */
export const SERVER_LOCAL_TOOL_NAMES = new Set([
  "get_server_readiness",
  "get_job_context",
  "discover_capabilities",
  "generate_setup_sheet",
  "compare_tool_databases",
  "compare_nc_files",
  "validate_machine_profile",
  "manufacturing_preflight",
  "analyze_regeneration_impact",
  "analyze_post_regression",
  "recommend_job_tooling",
  "analyze_toolpath_risk",
  "analyze_nc_program",
  "analyze_cycle_time",
  "generate_operation_packet",
  "calculate_thread_tap",
  "plan_od_rough_finish"
]);

/** Native bridge calls consumed internally by the combined readiness report. */
export const LIVE_NATIVE_STAGE_A_TOOL_NAMES = new Set([
  "mastercam_status",
  "mastercam_capabilities"
]);

/**
 * Internal Stage-B read-only bridge mappings. Job context invokes these as
 * available; they are not separately advertised as overlapping context tools.
 */
export const LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES = new Set([
  "get_programming_context",
  "list_operations",
  "get_operation",
  "get_operation_parameters",
  "find_operations",
  "get_dirty_toolpaths",
  "get_toolpath_status",
  "list_tools",
  "get_tool"
]);

export function stageBReadsEnabled(): boolean {
  const value = process.env.MASTERCAM_MCP_ENABLE_STAGE_B_READS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function isServerLocalTool(name: string): boolean {
  return SERVER_LOCAL_TOOL_NAMES.has(name);
}

export function isStageANativeTool(name: string): boolean {
  return LIVE_NATIVE_STAGE_A_TOOL_NAMES.has(name);
}

export function isStageBNativeReadTool(name: string): boolean {
  return LIVE_NATIVE_STAGE_B_READ_TOOL_NAMES.has(name);
}
