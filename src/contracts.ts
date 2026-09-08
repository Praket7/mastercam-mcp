export type Profile = "read" | "core" | "write" | "advanced" | "dev";
export type ToolResult = { ok: boolean; tool: string; data?: unknown; error?: { code: string; message: string }; receipt?: unknown };
export type Request = { id: string; tool: string; arguments?: Record<string, unknown> };
export type Response = { id: string; result: ToolResult };

export const READ_TOOLS = [
  "mastercam_status", "mastercam_capabilities", "get_active_part", "get_geometry_summary", "get_selection",
  "list_machine_groups", "list_operations", "get_operation", "get_operation_parameters", "get_stock", "get_wcs",
  "list_tools", "get_toolpath_status", "get_post_processor", "capture_view", "estimate_cycle_time", "compare_toolpaths"
  , "mastercam_doctor", "mastercam_help", "list_tool_categories", "mastercam_plan", "inspect", "measure", "assert", "preview_change", "find_operations", "get_version_report", "client_setup_check", "get_audit_history"
] as const;

export const WRITE_TOOLS = [
  "set_feed_speed", "change_tool", "create_operation", "regenerate_toolpath", "duplicate_operation", "update_stock", "set_work_offset", "rollback_change"
] as const;

export const ADVANCED_TOOLS = ["run_simulation", "detect_collisions"] as const;
export const HIGH_RISK_TOOLS = ["post_program"] as const;

export function allowed(tool: string, profile: Profile, hardReadOnly: boolean, dryRun: boolean) {
  if (READ_TOOLS.includes(tool as never)) return true;
  if (hardReadOnly) return false;
  if (WRITE_TOOLS.includes(tool as never)) return profile === "core" || profile === "write" || profile === "advanced" || profile === "dev";
  if (ADVANCED_TOOLS.includes(tool as never)) return !dryRun && (profile === "advanced" || profile === "dev");
  if (HIGH_RISK_TOOLS.includes(tool as never)) return false;
  return false;
}
