import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { MockBackend } from "./backend.js";
import { LiveBackend } from "./live-backend.js";
import { createMcpServer } from "./mcp/create-server.js";
import { selectedBackend } from "./platform.js";
import { loadConfig } from "./config.js";
import { AuditLog } from "./audit/audit-log.js";

const config = loadConfig();
const pipe = config.pipe;
const fixture = process.env.MASTERCAM_MCP_FIXTURE ? JSON.parse(readFileSync(process.env.MASTERCAM_MCP_FIXTURE, "utf8")) : undefined;
const mode = selectedBackend();
const audit = new AuditLog(config.audit);
const backend =
  mode === "mock" ? new MockBackend(fixture, audit)
  : process.platform !== "win32" ? new MockBackend(fixture, audit)
  : new LiveBackend({ endpoint: pipe });
const server = createMcpServer(backend, config.profile, config.hardReadOnly, audit);
await server.connect(new StdioServerTransport());
