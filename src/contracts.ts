/**
 * Capability tiers (audit §66): "reflection found a method" is never allowed to
 * be confused with "we know this works".
 */
export type CapabilityTier =
  | "UNAVAILABLE"
  | "DISCOVERED"
  | "IMPLEMENTED"
  | "LIVE_READ_VERIFIED"
  | "LIVE_WRITE_VERIFIED";

export const TIER_ORDER: readonly CapabilityTier[] = [
  "UNAVAILABLE", "DISCOVERED", "IMPLEMENTED", "LIVE_READ_VERIFIED", "LIVE_WRITE_VERIFIED"
];

export type Profile = "read" | "write" | "all";
export const DEFAULT_PROFILE: Profile = "read";

export const SUPPORTED_PROTOCOL_REVISIONS = ["2025-06-18"] as const;
export const CURRENT_PROTOCOL_REVISION = "2025-06-18";

export const READ_TOOLS = [
  "mastercam_status", "mastercam_capabilities", "get_active_part", "get_geometry_summary", "get_selection",
  "list_machine_groups", "list_operations", "get_operation", "get_operation_parameters", "get_stock", "get_wcs",
  "list_tools", "get_tool", "get_toolpath_status", "get_post_processor", "capture_view", "estimate_cycle_time",
  "compare_toolpaths", "mastercam_doctor", "mastercam_help", "list_tool_categories", "discover_capabilities",
  "get_compatibility_matrix", "mastercam_plan", "inspect",  "explain_operation", "get_operation_risks", "measure",
  "assert", "verify_change", "find_operations", "get_version_report", "client_setup_check", "get_audit_history",
  "get_machine_context", "get_fixture_info", "generate_setup_sheet", "compare_tool_databases", "compare_nc_files",
  "validate_machine_profile", "get_programming_context", "get_dirty_toolpaths", "get_selected_entities", "get_machine_groups"
] as const;

/** Preview is a read: it changes nothing in Mastercam. */
export const PREVIEW_TOOLS = ["preview_operation_parameters"] as const;

/** Applies/rollbacks are the controlled mutation entry points. */
export const WRITE_TOOLS = [
  "apply_operation_parameter_preview", "rollback_change", "change_tool", "regenerate_toolpath",
  "update_stock", "set_work_offset", "duplicate_operation", "create_operation"
] as const;

export const ADVANCED_TOOLS = ["run_simulation", "detect_collisions"] as const;

/** Intentionally never callable (audit §60/79): exposed only as unavailable capability metadata. */
export const FORBIDDEN_TOOLS = ["post_program", "cycle_start", "send_dnc", "execute_script"] as const;

export type ToolCategory = "read" | "preview" | "write" | "advanced" | "forbidden";

export function categoryOf(tool: string): ToolCategory {
  if ((READ_TOOLS as readonly string[]).includes(tool)) return "read";
  if ((PREVIEW_TOOLS as readonly string[]).includes(tool)) return "preview";
  if ((WRITE_TOOLS as readonly string[]).includes(tool)) return "write";
  if ((ADVANCED_TOOLS as readonly string[]).includes(tool)) return "advanced";
  return "forbidden";
}

export function isRegisteredTool(tool: string): boolean {
  return categoryOf(tool) !== "forbidden";
}

/**
 * Profile policy. The server-side policy is authoritative; annotations are only
 * host hints (audit ARCH-03).
 */
export function allowed(tool: string, profile: Profile, hardReadOnly: boolean, _dryRun?: boolean): boolean {
  const category = categoryOf(tool);
  if (category === "forbidden") return false;
  if (hardReadOnly) return category === "read" || category === "preview";
  switch (profile) {
    case "read": return category === "read" || category === "preview";
    case "write": return category === "read" || category === "preview" || category === "write";
    case "all": return true;
    default: return false;
  }
}
