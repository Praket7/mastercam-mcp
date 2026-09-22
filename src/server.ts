import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { MockBackend } from "./backend.js";
import { LiveBackend } from "./live-backend.js";
import { createMcpServer } from "./mcp/create-server.js";
import { selectedBackend } from "./platform.js";
import { loadConfig } from "./config.js";
import { AuditLog } from "./audit/audit-log.js";

const config = loadConfig();
const fixture = process.env.MASTERCAM_MCP_FIXTURE
  ? JSON.parse(readFileSync(process.env.MASTERCAM_MCP_FIXTURE, "utf8"))
  : undefined;
const mode = selectedBackend(config.backend);
if (mode === "live" && process.platform !== "win32") {
  throw new Error("Live Mastercam backend requires Windows. Set MASTERCAM_MCP_BACKEND=mock on this platform.");
}

const audit = new AuditLog(config.audit);
const backend = mode === "mock"
  ? new MockBackend(fixture, audit)
  : new LiveBackend({
      endpoint: config.pipe,
      connectTimeoutMs: config.transport.connectTimeoutMs,
      idleTimeoutMs: config.transport.idleTimeoutMs,
      maxResponseBytes: config.transport.maxResponseBytes,
      circuitBreaker: config.transport.circuitBreaker
    });

const server = createMcpServer(backend, config.profile, config.hardReadOnly, audit);
await server.connect(new StdioServerTransport());
