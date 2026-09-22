import { TOOL_MANIFEST } from "./tool-manifest.js";

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

export const SUPPORTED_PROTOCOL_REVISIONS = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;
export const CURRENT_PROTOCOL_REVISION = "2026-07-28";

export type ToolCategory = "read" | "preview" | "write" | "advanced" | "forbidden";

function namesFor(category: ToolCategory): readonly string[] {
  return Object.freeze(
    TOOL_MANIFEST
      .filter(entry => entry.category === category && (category === "forbidden" || entry.registered))
      .map(entry => entry.name)
  );
}

export const READ_TOOLS = namesFor("read");
export const PREVIEW_TOOLS = namesFor("preview");
export const WRITE_TOOLS = namesFor("write");
export const ADVANCED_TOOLS = namesFor("advanced");
export const FORBIDDEN_TOOLS = namesFor("forbidden");

const CATEGORY_BY_NAME = new Map<string, ToolCategory>(
  TOOL_MANIFEST.map(entry => [entry.name, entry.category])
);
const REGISTERED = new Set(
  TOOL_MANIFEST.filter(entry => entry.registered).map(entry => entry.name)
);

export function categoryOf(tool: string): ToolCategory {
  return CATEGORY_BY_NAME.get(tool) ?? "forbidden";
}

export function isRegisteredTool(tool: string): boolean {
  return REGISTERED.has(tool);
}

export function allowed(tool: string, profile: Profile, hardReadOnly: boolean, _dryRun?: boolean): boolean {
  const category = categoryOf(tool);
  if (!isRegisteredTool(tool) || category === "forbidden") return false;
  if (hardReadOnly) return category === "read" || category === "preview";
  switch (profile) {
    case "read": return category === "read" || category === "preview";
    case "write": return category === "read" || category === "preview" || category === "write";
    case "all": return true;
    default: return false;
  }
}
