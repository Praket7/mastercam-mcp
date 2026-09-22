import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
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
    onerror: error => {
      console.error("[mastercam-mcp] MCP handler error:", error.message);
    }
  }
);

class RequestBodyTooLargeError extends Error {}

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

async function readBoundedBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : new Uint8Array();
}

function requestHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const body = await readBoundedBody(req, config.http.maxRequestBodyBytes);
  const hostHeader = req.headers.host ?? `${host}:${port}`;
  const url = new URL(req.url ?? "/mcp", `http://${hostHeader}`);
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers: requestHeaders(req)
  };
  if (body !== undefined) init.body = body;
  return new Request(url, init);
}

async function writeWebResponse(
  res: http.ServerResponse,
  response: Response
): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  response.headers.forEach((value, name) => res.setHeader(name, value));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
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
    const request = await toWebRequest(req);
    const response = await mcpHandler.fetch(request);
    await writeWebResponse(res, response);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      reject(res, 413, error.message);
      return;
    }
    throw error;
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
