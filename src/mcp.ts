import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allowed, READ_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, HIGH_RISK_TOOLS } from "./contracts.js";
import type { Backend } from "./backend.js";
import { doctor } from "./diagnostics.js";
import { VERSION } from "./version.js";

const common: z.ZodRawShape = {
  operationId: z.unknown().optional(), operationIds: z.array(z.unknown()).optional(), feed: z.number().optional(), speed: z.number().optional(),
  toolId: z.unknown().optional(), name: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional(), outputPath: z.string().optional()
  , path: z.string().optional(), equals: z.unknown().optional(), beforeFeed: z.number().optional(), category: z.string().optional(), query: z.string().optional()
};

export function createMcpServer(backend: Backend, profile: string, hardReadOnly: boolean) {
  const server = new McpServer({ name: "mastercam-mcp", version: VERSION });
  for (const [name, uri, tool] of [["active-part", "mastercam://active-part", "get_active_part"], ["operations", "mastercam://operations", "list_operations"], ["diagnostics", "mastercam://diagnostics", "mastercam_doctor"]] as const) {
    server.registerResource(name, uri, { description: `Live ${name} information from Mastercam`, mimeType: "application/json" }, async () => {
      const data = tool === "mastercam_doctor"
        ? await doctor(process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default", process.env.MASTERCAM_MCP_BACKEND ?? "pipe")
        : await backend.call({ id: randomUUID(), tool, arguments: {} });
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }] };
    });
  }
  const names = [...READ_TOOLS, ...WRITE_TOOLS, ...ADVANCED_TOOLS, ...HIGH_RISK_TOOLS];
  for (const name of names) {
    server.registerTool(name, { description: descriptions[name] ?? `Mastercam ${name.replaceAll("_", " ")}`, inputSchema: schemas[name] ?? z.object(common).passthrough() }, async (args: Record<string, unknown>, extra) => {
      const dryRun = Boolean(args?.dryRun);
      if (!allowed(name, profile as never, hardReadOnly, dryRun)) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool ${name} is not enabled by the server profile` } }) }] };
      if (WRITE_TOOLS.includes(name as never) && !dryRun && args?.confirmed !== true) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code: "CONFIRMATION_REQUIRED", message: `Tool ${name} requires confirmed: true after preview and reread planning` } }) }] };
      try {
        await progress(extra, name, 1, 3, "started");
        if (name === "mastercam_doctor") return completed(extra, name, await doctor(process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default", process.env.MASTERCAM_MCP_BACKEND ?? "pipe"));
        if (name === "mastercam_help") return completed(extra, name, { ok: true, tool: name, data: descriptions });
        if (name === "list_tool_categories") return completed(extra, name, { ok: true, tool: name, data: { read: READ_TOOLS, write: WRITE_TOOLS, advanced: ADVANCED_TOOLS, highRisk: HIGH_RISK_TOOLS } });
        if (name === "mastercam_plan") return completed(extra, name, { ok: true, tool: name, data: { steps: ["inspect target", "preview requested change", "request confirmation", "apply change", "verify result"], safeDefault: "read only" } });
        const result = await backend.call({ id: randomUUID(), tool: name, arguments: args ?? {} });
        await progress(extra, name, 3, 3, "completed");
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        await progress(extra, name, 3, 3, "failed");
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: String(error) } }) }] };
      }
    });
  }
  return server;
}

const descriptions: Record<string, string> = {
  mastercam_doctor: "Check local prerequisites, configuration, and named pipe readiness",
  mastercam_help: "Explain the available Mastercam MCP tools and safety levels",
  list_tool_categories: "List tools by read, write, advanced, and high risk category",
  mastercam_plan: "Create a safe inspect, preview, confirm, apply, and verify plan",
  discover_capabilities: "Show the available capabilities and the next safe action",
  find_operations: "Search operations by name, type, tool, or machine group",
  explain_operation: "Explain an operation in plain language with its inputs and risks",
  get_operation_risks: "Report verification scope and risks for an operation",
  verify_change: "Reread an operation and verify a requested change",
  get_machine_context: "Return machine, stock, workholding, and coordinate context",
  get_fixture_info: "Describe the active fixture and replay capabilities",
  get_version_report: "Report detected Mastercam and NET Hook compatibility",
  client_setup_check: "Validate client configuration readiness",
  get_audit_history: "Show local change receipts and rollback history",
  inspect: "Inspect a target and return its current values",
  measure: "Measure one named value on a Mastercam target",
  assert: "Verify that a measured value matches an expected value",
  preview_change: "Preview a change with before, after, regeneration, and rollback information"
};

const schemas: Record<string, z.ZodTypeAny> = {
  inspect: z.object({ operationId: z.union([z.string(), z.number()]).optional(), path: z.string().optional() }),
  measure: z.object({ operationId: z.union([z.string(), z.number()]).optional(), path: z.string().min(1).default("operation.feed") }),
  assert: z.object({ operationId: z.union([z.string(), z.number()]).optional(), path: z.string().min(1).default("operation.feed"), equals: z.unknown() }),
  set_feed_speed: z.object({ operationId: z.union([z.string(), z.number()]).optional(), feed: z.number().finite().positive(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() }),
  preview_change: z.object({ operationId: z.union([z.string(), z.number()]).optional(), feed: z.number().finite().positive() }),
  rollback_change: z.object({ operationId: z.union([z.string(), z.number()]).optional(), beforeFeed: z.number().finite().positive(), confirmed: z.boolean().optional() })
  , find_operations: z.object({ query: z.string().optional(), category: z.string().optional() })
  , discover_capabilities: z.object({ category: z.string().optional() })
  , explain_operation: z.object({ operationId: z.union([z.string(), z.number()]).optional() })
  , get_operation_risks: z.object({ operationId: z.union([z.string(), z.number()]).optional() })
  , verify_change: z.object({ operationId: z.union([z.string(), z.number()]).optional(), feed: z.number().finite().positive().optional(), expectedFeed: z.number().finite().positive().optional() })
  , get_machine_context: z.object({})
  , get_fixture_info: z.object({})
};

function completed(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: never) => Promise<void> }, name: string, value: unknown) {
  return progress(extra, name, 3, 3, "completed").then(() => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] }));
}

async function progress(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: never) => Promise<void> }, tool: string, progressValue: number, total: number, message: string) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: progressValue, total, message: `${tool}: ${message}` } } as never);
}
