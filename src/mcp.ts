import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allowed, READ_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, HIGH_RISK_TOOLS } from "./contracts.js";
import type { Backend } from "./backend.js";

const common: z.ZodRawShape = {
  operationId: z.unknown().optional(), operationIds: z.array(z.unknown()).optional(), feed: z.number().optional(), speed: z.number().optional(),
  toolId: z.unknown().optional(), name: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional(), outputPath: z.string().optional()
};

export function createMcpServer(backend: Backend, profile: string, hardReadOnly: boolean) {
  const server = new McpServer({ name: "mastercam-mcp", version: "0.1.0" });
  const names = [...READ_TOOLS, ...WRITE_TOOLS, ...ADVANCED_TOOLS, ...HIGH_RISK_TOOLS];
  for (const name of names) {
    server.registerTool(name, { description: `Mastercam ${name.replaceAll("_", " ")}`, inputSchema: z.object(common).passthrough() }, async (args: Record<string, unknown>) => {
      const dryRun = Boolean(args?.dryRun);
      if (!allowed(name, profile as never, hardReadOnly, dryRun)) return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool ${name} is not enabled by the server profile` } }) }] };
      try {
        const result = await backend.call({ id: randomUUID(), tool: name, arguments: args ?? {} });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: String(error) } }) }] };
      }
    });
  }
  return server;
}
