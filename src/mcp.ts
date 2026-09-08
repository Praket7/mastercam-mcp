import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allowed, READ_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, HIGH_RISK_TOOLS } from "./contracts.js";
import type { Backend } from "./backend.js";
import { doctor } from "./diagnostics.js";

const common: z.ZodRawShape = {
  operationId: z.unknown().optional(), operationIds: z.array(z.unknown()).optional(), feed: z.number().optional(), speed: z.number().optional(),
  toolId: z.unknown().optional(), name: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional(), outputPath: z.string().optional()
  , path: z.string().optional(), equals: z.unknown().optional(), beforeFeed: z.number().optional(), category: z.string().optional(), query: z.string().optional()
};

export function createMcpServer(backend: Backend, profile: string, hardReadOnly: boolean) {
  const server = new McpServer({ name: "mastercam-mcp", version: "0.1.3" });
  const names = [...READ_TOOLS, ...WRITE_TOOLS, ...ADVANCED_TOOLS, ...HIGH_RISK_TOOLS];
  for (const name of names) {
    server.registerTool(name, { description: descriptions[name] ?? `Mastercam ${name.replaceAll("_", " ")}`, inputSchema: z.object(common).passthrough() }, async (args: Record<string, unknown>, extra) => {
      const dryRun = Boolean(args?.dryRun);
      if (!allowed(name, profile as never, hardReadOnly, dryRun)) return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool ${name} is not enabled by the server profile` } }) }] };
      try {
        await progress(extra, name, 1, 3, "started");
        if (name === "mastercam_doctor") return { content: [{ type: "text", text: JSON.stringify(await doctor(process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default", process.env.MASTERCAM_MCP_BACKEND ?? "pipe")) }] };
        if (name === "mastercam_help") return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, data: descriptions }) }] };
        if (name === "list_tool_categories") return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, data: { read: READ_TOOLS, write: WRITE_TOOLS, advanced: ADVANCED_TOOLS, highRisk: HIGH_RISK_TOOLS } }) }] };
        if (name === "mastercam_plan") return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, data: { steps: ["inspect target", "preview requested change", "request confirmation", "apply change", "verify result"], safeDefault: "read only" } }) }] };
        const result = await backend.call({ id: randomUUID(), tool: name, arguments: args ?? {} });
        await progress(extra, name, 3, 3, "completed");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: String(error) } }) }] };
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
  inspect: "Inspect a target and return its current values",
  measure: "Measure one named value on a Mastercam target",
  assert: "Verify that a measured value matches an expected value",
  preview_change: "Preview a change with before, after, regeneration, and rollback information"
};

async function progress(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: never) => Promise<void> }, tool: string, progressValue: number, total: number, message: string) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: progressValue, total, message: `${tool}: ${message}` } } as never);
}
