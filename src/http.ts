import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MockBackend } from "./backend.js";
import { LiveBackend } from "./live-backend.js";
import { createMcpServer } from "./mcp/create-server.js";
import { selectedBackend } from "./platform.js";
import { classifyAccess, classifyRequest } from "./http-security.js";
import type { Backend } from "./backend.js";
import { AuditLog } from "./audit/audit-log.js";
import { loadConfig } from "./config.js";
import { CURRENT_PROTOCOL_REVISION } from "./contracts.js";

const config = loadConfig();
const audit = new AuditLog(config.audit);
if (audit.integrityError) {
  throw new Error(`Audit log integrity check failed: ${audit.integrityError}`);
}

const mode = selectedBackend(config.backend);
if (mode === "live" && process.platform !== "win32") {
  throw new Error(
    "Live Mastercam backend requires Windows. Set MASTERCAM_MCP_BACKEND=mock on this platform."
  );
}

const backend: Backend =
  mode === "mock"
    ? new MockBackend(loadFixture(), audit)
    : new LiveBackend({
        endpoint: config.pipe,
        connectTimeoutMs: config.transport.connectTimeoutMs,
        idleTimeoutMs: config.transport.idleTimeoutMs,
        maxResponseBytes: config.transport.maxResponseBytes,
        circuitBreaker: config.transport.circuitBreaker
      });

const token = config.http.token;
const host = config.http.host;
const port = config.http.port;
const allowedOrigins = new Set(config.http.allowedOrigins);
const remote = config.http.allowRemote;

if (remote && allowedOrigins.size === 0) {
  throw new Error(
    "MASTERCAM_MCP_ALLOWED_ORIGINS is required when remote HTTP access is enabled"
  );
}

let activeRequests = 0;
let shuttingDown = false;

const mcpHandler = createMcpHandler(
  () => createMcpServer(backend, config.profile, config.hardReadOnly),
  {
    legacy: "stateless",
    responseMode: "auto",
    maxRequestBodySize: config.http.maxRequestBodyBytes,
    onerror: error => {
      console.error("[mastercam-mcp] MCP handler error:", error.message);
    }
  }
);

const nodeMcpHandler = toNodeHandler(mcpHandler, {
  maxRequestBodySize: config.http.maxRequestBodyBytes,
  onerror: error => {
    console.error("[mastercam-mcp] Node HTTP adapter error:", error.message);
  }
});

function verdict(req: http.IncomingMessage) {
  return classifyRequest(
    req.method,
    req.url,
    {
      origin: req.headers.origin,
      host: req.headers.host,
      authorization: req.headers.authorization
    },
    { token, allowedOrigins, remote }
  );
}

function reject(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch(error => {
    const requestId = randomUUID();
    console.error(
      `[mastercam-mcp] request ${requestId} failed:`,
      error instanceof Error ? error.message : error
    );
    reject(res, 500, "Internal server error");
  });
});

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.url === "/health") {
    const access = classifyAccess(
      {
        origin: req.headers.origin,
        host: req.headers.host,
        authorization: req.headers.authorization
      },
      { token, allowedOrigins, remote }
    );
    if (access.status !== 200) {
      reject(res, access.status, access.message ?? "Rejected");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        activeRequests,
        protocol: CURRENT_PROTOCOL_REVISION,
        legacyFallback: "stateless"
      })
    );
    return;
  }

  const check = verdict(req);
  if (check.status !== 200) {
    reject(res, check.status, check.message ?? "Rejected");
    return;
  }

  if (shuttingDown) {
    reject(res, 503, "Server shutting down");
    return;
  }

  if (activeRequests >= config.http.maxConcurrency) {
    reject(res, 503, "Server busy");
    return;
  }

  activeRequests++;
  try {
    await nodeMcpHandler(req, res);
  } finally {
    activeRequests--;
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await mcpHandler.close().catch(() => undefined);
  await backend.close?.().catch(() => undefined);
  await audit.flush().catch(() => undefined);
  await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

server.listen(port, host, () => {
  console.error(`Mastercam MCP HTTP listening on http://${host}:${port}/mcp`);
});
server.headersTimeout = 30_000;
server.requestTimeout = config.http.requestTimeoutMs;
server.keepAliveTimeout = 5_000;

function loadFixture() {
  const path = process.env.MASTERCAM_MCP_FIXTURE;
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid MASTERCAM_MCP_FIXTURE: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
