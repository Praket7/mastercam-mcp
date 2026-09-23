import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod/v4";
import { JobToolSchema } from "./job-intelligence.js";

const ToolLibrarySchema = z.object({
  schema: z.literal("mastercam-mcp/tool-library/v1"),
  units: z.enum(["mm", "inch"]),
  tools: z.array(JobToolSchema).min(1).max(5000)
}).strict();

export type ShopToolLibrary = {
  schema: "mastercam-mcp/tool-library/v1";
  units?: "mm" | "inch";
  tools: z.infer<typeof JobToolSchema>[];
};

/** Load an operator-configured, exported shop inventory; no tool data is guessed. */
export function loadShopToolLibrary(path = process.env.MASTERCAM_MCP_TOOL_LIBRARY): ShopToolLibrary | undefined {
  if (!path?.trim()) return undefined;
  const info = statSync(path);
  if (!info.isFile()) throw new Error("Configured tool library must be a regular file");
  if (info.size > 2_000_000) throw new Error("Configured tool library exceeds the 2 MB limit");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Configured tool library is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ToolLibrarySchema.parse(json);
  return {
    ...parsed,
    tools: parsed.tools.map(tool => ({
      ...tool,
      provenance: tool.provenance.length > 0
        ? tool.provenance
        : [{ source: `shop tool library (${basename(path)})`, verified: false }]
    }))
  };
}

/** Merge a shop inventory with tools actually referenced by the active job. */
export function mergeActiveJobTools(library: ShopToolLibrary | undefined, activeTools: unknown[]): ShopToolLibrary | undefined {
  const tools = new Map<string, z.infer<typeof JobToolSchema>>();
  for (const tool of library?.tools ?? []) tools.set(toolKey(tool), tool);
  for (const raw of activeTools) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const candidate = JobToolSchema.safeParse({
      id: value.id ?? value.number,
      ...(typeof value.number === "number" ? { number: value.number } : {}),
      name: typeof value.name === "string" && value.name ? value.name : `Tool ${String(value.number ?? value.id ?? "unknown")}`,
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.diameter === "number" ? { diameter: value.diameter } : {}),
      ...(typeof value.insert === "string" ? { insert: value.insert } : {}),
      ...(typeof value.grade === "string" ? { grade: value.grade } : {}),
      materials: [],
      operations: [],
      provenance: [{ source: "referenced by active Mastercam operation", verified: false }]
    });
    if (!candidate.success) continue;
    const active = candidate.data;
    const key = toolKey(active);
    const stored = tools.get(key);
    tools.set(key, stored ? {
      ...stored,
      ...active,
      materials: stored.materials,
      operations: stored.operations,
      provenance: [...stored.provenance, ...active.provenance]
    } : active);
  }
  if (!library && tools.size === 0) return undefined;
  return { schema: "mastercam-mcp/tool-library/v1", units: library?.units, tools: [...tools.values()] };
}

function toolKey(tool: z.infer<typeof JobToolSchema>): string {
  return tool.number !== undefined ? `number:${tool.number}` : tool.id !== undefined ? `id:${tool.id}` : `name:${tool.name.toLowerCase()}`;
}
