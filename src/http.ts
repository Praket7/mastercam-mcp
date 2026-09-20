import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MockBackend, PipeBackend } from "./backend.js";
import { createMcpServer } from "./mcp/create-server.js";
import { defaultPipe, selectedBackend } from "./platform.js";
import { classifyRequest } from "./http-security.js";
import type { Backend } from "./backend.js";

const profile = (process.env.MASTERCAM_MCP_PROFILE ?? "read") as "read" | "write" | "all";
const hardReadOnly = process.env.MASTERCAM_MCP_HARD_READ_ONLY !== "0";
const pipe = process.env.MASTERCAM_MCP_PIPE ?? defaultPipe();
const backend: Backend = selectedBackend() === "mock"
  ? new MockBackend(loadFixture())
  : new PipeBackend(pipe);
const token = process.env.MASTERCAM_MCP_HTTP_TOKEN;
const host = process.env.MASTERCAM_MCP_HTTP_HOST ?? "127.0.0.1";
const port = parsePort(process.env.MASTERCAM_MCP_HTTP_PORT ?? "8787");
const allowedOrigins = new Set((process.env.MASTERCAM_MCP_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean));
const remote = process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE === "1";
if (remote && allowedOrigins.size === 0) throw new Error("MASTERCAM_MCP_ALLOWED_ORIGINS is required when remote HTTP access is enabled");

const maxRequestBodyBytes = parsePositiveInt(process.env.MASTERCAM_MCP_HTTP_MAX_BODY_BYTES, 2 * 1024 * 1024);
const maxConcurrentRequests = parsePositiveInt(process.env.MASTERCAM_MCP_HTTP_MAX_CONCURRENCY, 32);
const requestTimeoutMs = parsePositiveInt(process.env.MASTERCAM_MCP_HTTP_REQUEST_TIMEOUT_MS, 120_000);
const sessionTtlMs = parsePositiveInt(process.env.MASTERCAM_MCP_HTTP_SESSION_TTL_MS, 1_800_000);

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
  touched: number;
  closed: boolean;
}
const sessions = new Map<string, Session>();
let activeRequests = 0;

/** Security verdict for an incoming request, using the shared pure helper. */
function verdict(req: http.IncomingMessage) {
  return classifyRequest(req.method, req.url, { origin: req.headers.origin, host: req.headers.host, authorization: req.headers.authorization }, { token, allowedOrigins, remote });
}

function reject(res: http.ServerResponse, status: number, message: string) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch(error => {
    // HTTP-04: a transport exception must never become an unhandled rejection.
    console.error(`[mastercam-mcp] request ${randomUUID()} failed:`, error instanceof Error ? error.message : error);
    reject(res, 500, "Internal server error");
  });
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, activeRequests }));
    return;
  }
  const check = verdict(req);
  if (check.status !== 200) {
    reject(res, check.status, check.message ?? "Rejected");
    return;
  }
  if (activeRequests >= maxConcurrentRequests) {
    reject(res, 503, "Server busy");
    return;
  }
  activeRequests++;
  const timeout = setTimeout(() => {
    if (!res.headersSent) reject(res, 504, "Request timed out");
  }, requestTimeoutMs);
  timeout.unref?.();
  try {
    if (req.method === "POST") {
      const contentLength = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) {
        reject(res, 413, "Request body too large");
        return;
      }
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session && req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          // The sessionId only exists once initialize has been handled, so the
          // session record is created here, from inside handleRequest. The
          // closure runs strictly after `transport` is assigned.
          sessions.set(id, {
            transport,
            close: async () => {
              // Close the transport and MCP server exactly once (HTTP-03).
              const existing = sessions.get(id);
              if (existing) { existing.closed = true; sessions.delete(id); }
              await transport.close().catch(() => undefined);
            },
            touched: Date.now(),
            closed: false
          });
        },
        onsessionclosed: id => {
          const existing = sessions.get(id);
          if (existing) existing.closed = true;
          sessions.delete(id);
        },
        enableJsonResponse: true,
        ...(allowedOrigins.size ? { allowedOrigins: [...allowedOrigins] } : {})
      });
      const mcp = createMcpServer(backend, profile, hardReadOnly);
      await mcp.connect(transport);
      try {
        // This call processes initialize and triggers onsessioninitialized.
        await transport.handleRequest(req, res);
        const id = transport.sessionId;
        const created = id ? sessions.get(id) : undefined;
        if (created) {
          const transportClose = created.close;
          created.close = async () => {
            await transportClose();
            await mcp.close().catch(() => undefined);
          };
        } else {
          // No session was created: leave no orphan MCP server behind (HTTP-03).
          await transport.close().catch(() => undefined);
          await mcp.close().catch(() => undefined);
        }
      } catch (error) {
        await transport.close().catch(() => undefined);
        await mcp.close().catch(() => undefined);
        throw error;
      }
      return;
    }
    if (!session) {
      reject(res, 404, "Unknown MCP session");
      return;
    }
    session.touched = Date.now();
    await session.transport.handleRequest(req, res);
  } finally {
    activeRequests--;
    clearTimeout(timeout);
  }
}

const cleanup = setInterval(() => {
  const cutoff = Date.now() - sessionTtlMs;
  for (const session of sessions.values()) {
    if (session.touched < cutoff && !session.closed) void session.close().catch(() => undefined);
  }
}, Math.min(sessionTtlMs, 60_000));
cleanup.unref();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanup);
    void Promise.all([...sessions.values()].map(session => session.close()))
      .catch(() => undefined)
      .finally(() => server.close(() => process.exit(0)));
  });
}

server.listen(port, host, () => console.error(`Mastercam MCP HTTP listening on http://${host}:${port}/mcp`));
server.headersTimeout = 30_000;
server.requestTimeout = requestTimeoutMs;
server.keepAliveTimeout = 5_000;

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid MASTERCAM_MCP_HTTP_PORT: ${value}`);
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid numeric setting: ${value}`);
  return parsed;
}

function loadFixture() {
  const path = process.env.MASTERCAM_MCP_FIXTURE;
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MASTERCAM_MCP_FIXTURE: ${error instanceof Error ? error.message : String(error)}`);
  }
}
