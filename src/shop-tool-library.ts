import { constants, fstatSync, openSync, readFileSync, closeSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod/v4";
import { JobToolSchema } from "./job-intelligence.js";

const ToolLibrarySchema = z.object({
  schema: z.literal("mastercam-mcp/tool-library/v1"),
  units: z.enum(["mm", "inch"]),
  tools: z.array(JobToolSchema).min(1).max(20000)
}).strict();

const IsoCatalogSchema = z.object({
  schemaVersion: z.string().min(1).max(32),
  publisher: z.string().min(1).max(256),
  generated: z.string().max(64).optional(),
  toolCount: z.number().int().positive().optional(),
  tools: z.array(z.object({
    toolNbr: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    url: z.string().url().optional(),
    toolTypes: z.array(z.string().min(1).max(128)).max(20).default([]),
    coatings: z.array(z.string().min(1).max(128)).max(20).default([]),
    specs: z.record(z.string(), z.unknown()).default({})
  }).passthrough()).min(1).max(20000)
}).passthrough().superRefine((catalog, context) => {
  if (catalog.toolCount !== undefined && catalog.toolCount !== catalog.tools.length) {
    context.addIssue({ code: "custom", message: "Catalog toolCount does not match its tool record count", path: ["toolCount"] });
  }
});

export type ShopToolLibrary = {
  schema: "mastercam-mcp/tool-library/v1";
  units?: "mm" | "inch";
  tools: z.infer<typeof JobToolSchema>[];
};

/** Load an operator-configured, exported shop inventory; no tool data is guessed. */
export function loadShopToolLibrary(path = process.env.MASTERCAM_MCP_TOOL_LIBRARY): ShopToolLibrary | undefined {
  if (!path?.trim()) return undefined;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let json: unknown;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error("Configured tool library must be a regular file");
    if (info.size > 10_000_000) throw new Error("Configured tool library exceeds the 10 MB limit");
    try {
      json = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch (error) {
      throw new Error(`Configured tool library is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    closeSync(descriptor);
  }
  if (json && typeof json === "object" && "schemaVersion" in json) {
    const isoCatalog = IsoCatalogSchema.parse(json);
    return {
      schema: "mastercam-mcp/tool-library/v1",
      units: "mm",
      tools: isoCatalog.tools.map(tool => {
        const dimension = (key: string): number | undefined => {
          const value = tool.specs[key];
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const record = value as Record<string, unknown>;
            const number = typeof record.mm === "number" ? record.mm : record.in;
            return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
          }
          return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
        };
        return JobToolSchema.parse({
          id: tool.toolNbr,
          name: tool.name,
          type: tool.toolTypes.join(", ") || "cutting tool",
          ...(dimension("DC") === undefined ? {} : { diameter: dimension("DC") }),
          ...(dimension("APMX") === undefined ? {} : { fluteLength: dimension("APMX"), maxDepth: dimension("APMX") }),
          ...(dimension("OAL") === undefined ? {} : { overallLength: dimension("OAL") }),
          ...(tool.coatings.length === 0 ? {} : { coating: tool.coatings.join(", ") }),
          materials: [],
          operations: tool.toolTypes.map(type => /end mill/i.test(type) ? "milling" : type.toLowerCase()),
          provenance: [{
            source: `${isoCatalog.publisher} ISO 13399 catalog v${isoCatalog.schemaVersion}${isoCatalog.generated ? ` generated ${isoCatalog.generated}` : ""}`,
            ...(tool.url === undefined ? {} : { reference: tool.url }),
            verified: false
          }]
        });
      })
    };
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
