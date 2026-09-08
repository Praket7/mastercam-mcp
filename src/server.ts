import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { allowed, READ_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS, HIGH_RISK_TOOLS } from "./contracts.js";
import { MockBackend, PipeBackend } from "./backend.js";

const profile = (process.env.MASTERCAM_MCP_PROFILE ?? "read") as any;
const hardReadOnly = process.env.MASTERCAM_MCP_HARD_READ_ONLY !== "0";
const pipe = process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default";
const backend = process.env.MASTERCAM_MCP_BACKEND === "mock" ? new MockBackend() : new PipeBackend(pipe);
const server = new McpServer({ name: "mastercam-mcp", version: "0.1.0" });

const common: z.ZodRawShape = {
  operationId: z.unknown().optional(), operationIds: z.array(z.unknown()).optional(), feed: z.number().optional(), speed: z.number().optional(),
  toolId: z.unknown().optional(), name: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional(), outputPath: z.string().optional()
};
const schemas: Record<string, z.ZodRawShape> = {};
for (const name of [...READ_TOOLS, ...WRITE_TOOLS, ...ADVANCED_TOOLS, ...HIGH_RISK_TOOLS]) schemas[name] = common;
for (const [name, shape] of Object.entries(schemas)) {
  server.registerTool(name, { description: `Mastercam ${name.replaceAll("_", " ")}`, inputSchema: shape }, async (args: any) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const dryRun = Boolean(input.dryRun);
    if (!allowed(name, profile, hardReadOnly, dryRun)) return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "PROFILE_DENIED", message: `Tool ${name} is not enabled by the server profile` } }) }] };
    try { const result = await backend.call({ id: randomUUID(), tool: name, arguments: input }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: String(error) } }) }] }; }
  });
}

await server.connect(new StdioServerTransport());
