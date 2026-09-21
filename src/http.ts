import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MockBackend } from "./backend.js";
import { LiveBackend } from "./live-backend.js";
import { createMcpServer } from "./mcp.js";
import { defaultPipe, selectedBackend } from "./platform.js";

const profile = process.env["MASTERCAM_MCP_PROFILE"] ?? "read";
const hardReadOnly = process.env["MASTERCAM_MCP_HARD_READ_ONLY"] !== "0";
const pipe = process.env["MASTERCAM_MCP_PIPE"] ?? defaultPipe();
const fixture = loadFixture();
const backend = selectedBackend() === "mock" ? new MockBackend(fixture) : new LiveBackend(pipe);
const token = process.env["MASTERCAM_MCP_HTTP_TOKEN"] ?? "";
const host = process.env["MASTERCAM_MCP_HTTP_HOST"] ?? "127.0.0.1";
const port = parsePort(process.env["MASTERCAM_MCP_HTTP_PORT"] ?? "8787");
const allowedOrigins = new Set((process.env["MASTERCAM_MCP_ALLOWED_ORIGINS"] ?? "").split(",").map(v => v.trim()).filter(Boolean));
const remote = process.env["MASTERCAM_MCP_HTTP_ALLOW_REMOTE"] === "1";
if (remote && allowedOrigins.size === 0) throw new Error("MASTERCAM_MCP_ALLOWED_ORIGINS is required when remote HTTP access is enabled");

const maxConcurrentRequests = parseInt(process.env["MASTERCAM_MCP_HTTP_MAX_CONCURRENT"] ?? "100", 10);
const requestTimeoutMs = parseInt(process.env["MASTERCAM_MCP_HTTP_REQUEST_TIMEOUT"] ?? "30000", 10);
const sessionTtlMs = parseDuration(process.env["MASTERCAM_MCP_HTTP_SESSION_TTL_MS"] ?? "1800000");

let activeRequests = 0;
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: ReturnType<typeof createMcpServer>; close: () => Promise<void>; touched: number }>();

function parseHostHeader(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const match = hostHeader.match(/^\[(.+)\](?::(\d+))?$/);
  if (match) return match[1] ?? "";
  return hostHeader.split(":")[0] ?? "";
}

function authorized(req: http.IncomingMessage): boolean {
  if (token && req.headers.authorization !== `Bearer ${token}`) return false;
  const origin = req.headers.origin ?? "";
  if (origin && !allowedOrigins.has(origin)) return false;
  const requestHost = parseHostHeader(req.headers.host);
  if (requestHost && requestHost !== "127.0.0.1" && requestHost !== "localhost" && requestHost !== "::1" && !remote) return false;
  return true;
}

function reject(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

const server = http.createServer(async (req, res) => {
  if (req.url !== "/mcp") return reject(res, 404, "Not found");
  if (!authorized(req)) return reject(res, 403, "Forbidden: Invalid Origin or Host");
  if (activeRequests >= maxConcurrentRequests) return reject(res, 503, "Too many concurrent requests");

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let current = sessionId ? sessions.get(sessionId) : undefined;

  if (!current && req.method === "POST") {
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        const mcp = createMcpServer(backend, profile, hardReadOnly);
        sessions.set(id, { transport, mcp, close: async () => { await transport.close(); await mcp.close(); }, touched: Date.now() });
      },
      onsessionclosed: id => { sessions.delete(id); },
      enableJsonResponse: true,
      ...(allowedOrigins.size ? { allowedOrigins: [...allowedOrigins] } : {})
    });
    const mcp = createMcpServer(backend, profile, hardReadOnly);
    await mcp.connect(transport);
    current = { transport, mcp, close: async () => { await transport.close(); await mcp.close(); }, touched: Date.now() };
  }

  if (!current) return reject(res, 404, "Unknown MCP session");

  const stored = sessionId ? sessions.get(sessionId) : undefined;
  if (stored) stored.touched = Date.now();

  activeRequests++;
  const timeout = setTimeout(() => {
    if (!res.writableEnded) reject(res, 504, "Request timeout");
  }, requestTimeoutMs);

  try {
    await current.transport.handleRequest(req, res);
  } catch (error) {
    if (!res.writableEnded) {
      console.error(`HTTP request error: ${error instanceof Error ? error.message : String(error)}`);
      reject(res, 500, "Internal server error");
    }
  } finally {
    clearTimeout(timeout);
    activeRequests--;
  }
});

const cleanup = setInterval(() => {
  const cutoff = Date.now() - sessionTtlMs;
  for (const [id, session] of sessions) {
    if (session.touched < cutoff) {
      void session.close().catch(() => undefined);
      sessions.delete(id);
    }
  }
}, Math.min(sessionTtlMs, 60000));
cleanup.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  clearInterval(cleanup);
  void Promise.all([...sessions.values()].map(session => session.close())).finally(() => server.close());
});

server.listen(port, host, () => console.error(`Mastercam MCP HTTP listening on http://${host}:${port}/mcp`));

function parsePort(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid MASTERCAM_MCP_HTTP_PORT: ${value}`);
  return parsed;
}

function parseDuration(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) throw new Error(`Invalid MASTERCAM_MCP_HTTP_SESSION_TTL_MS: ${value}`);
  return parsed;
}

function loadFixture() {
  const path = process.env["MASTERCAM_MCP_FIXTURE"];
  if (!path) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Invalid MASTERCAM_MCP_FIXTURE: ${error instanceof Error ? error.message : String(error)}`); }
}