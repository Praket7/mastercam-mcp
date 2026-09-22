/**
 * Tools implemented entirely by the TypeScript server. They do not invoke a
 * Mastercam adapter and are therefore available in both fixture and live
 * modes. Keep this list small and explicit so live discovery cannot drift
 * into advertising unverified native mappings.
 */
export const SERVER_LOCAL_TOOL_NAMES = new Set([
  "mastercam_help",
  "list_tool_categories",
  "discover_capabilities",
  "get_compatibility_matrix",
  "mastercam_plan",
  "mastercam_doctor",
  "generate_setup_sheet",
  "compare_tool_databases",
  "compare_nc_files",
  "validate_machine_profile"
]);

/** Native capabilities implemented by the current Stage-A adapters. */
export const LIVE_NATIVE_STAGE_A_TOOL_NAMES = new Set([
  "mastercam_status",
  "mastercam_capabilities"
]);

export function isServerLocalTool(name: string): boolean {
  return SERVER_LOCAL_TOOL_NAMES.has(name);
}

export function isStageANativeTool(name: string): boolean {
  return LIVE_NATIVE_STAGE_A_TOOL_NAMES.has(name);
}
