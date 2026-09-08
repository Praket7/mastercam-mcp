import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MockBackend, PipeBackend } from "./backend.js";
import { createMcpServer } from "./mcp.js";

const profile = process.env.MASTERCAM_MCP_PROFILE ?? "read";
const hardReadOnly = process.env.MASTERCAM_MCP_HARD_READ_ONLY !== "0";
const pipe = process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default";
const backend = process.env.MASTERCAM_MCP_BACKEND === "mock" ? new MockBackend() : new PipeBackend(pipe);
const token = process.env.MASTERCAM_MCP_HTTP_TOKEN;
const host = process.env.MASTERCAM_MCP_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.MASTERCAM_MCP_HTTP_PORT ?? 8787);
const allowedOrigins = new Set((process.env.MASTERCAM_MCP_ALLOWED_ORIGINS ?? "").split(",").map(v => v.trim()).filter(Boolean));
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; close: () => Promise<void> }>();

function authorized(req: http.IncomingMessage) {
  if (!token) return false;
  if (req.headers.authorization !== `Bearer ${token}`) return false;
  const origin = req.headers.origin;
  if (origin && allowedOrigins.size && !allowedOrigins.has(origin)) return false;
  const requestHost = req.headers.host?.split(":")[0];
  if (requestHost && requestHost !== "127.0.0.1" && requestHost !== "localhost" && process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE !== "1") return false;
  return true;
}

function reject(res: http.ServerResponse, status: number, message: string) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: message })); }

const server = http.createServer(async (req, res) => {
  if (req.url !== "/mcp") return reject(res, 404, "Not found");
  if (!authorized(req)) return reject(res, 401, "Unauthorized");
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let current = sessionId ? sessions.get(sessionId) : undefined;
  if (!current && req.method === "POST") {
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { sessions.set(id, { transport, close: async () => { await transport.close(); } }); },
      onsessionclosed: id => { sessions.delete(id); },
      enableJsonResponse: true,
      ...(allowedOrigins.size ? { allowedOrigins: [...allowedOrigins] } : {})
    });
    const mcp = createMcpServer(backend, profile, hardReadOnly);
    await mcp.connect(transport);
    current = { transport, close: async () => { await mcp.close(); } };
  }
  if (!current) return reject(res, 404, "Unknown MCP session");
  await current.transport.handleRequest(req, res);
});

server.listen(port, host, () => console.error(`Mastercam MCP HTTP listening on http://${host}:${port}/mcp`));
