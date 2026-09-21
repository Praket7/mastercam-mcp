import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { MockBackend } from "./backend.js";
import { LiveBackend } from "./live-backend.js";
import { createMcpServer } from "./mcp/create-server.js";
import { defaultPipe, selectedBackend } from "./platform.js";
import { DEFAULT_PROFILE } from "./contracts.js";
import type { Profile } from "./contracts.js";
import { AuditLog } from "./audit/audit-log.js";

function parseProfile(value: string | undefined): Profile {
  if (value === undefined || value === "") return DEFAULT_PROFILE;
  if (value === "read" || value === "write" || value === "all") return value;
  // Invalid profiles fail startup instead of being silently cast (audit §59).
  throw new Error(`Invalid MASTERCAM_MCP_PROFILE '${value}'. Supported profiles: read, write, all.`);
}

const profile = parseProfile(process.env.MASTERCAM_MCP_PROFILE);
const hardReadOnly = process.env.MASTERCAM_MCP_HARD_READ_ONLY !== "0";
const pipe = process.env.MASTERCAM_MCP_PIPE ?? defaultPipe();
const fixture = process.env.MASTERCAM_MCP_FIXTURE ? JSON.parse(readFileSync(process.env.MASTERCAM_MCP_FIXTURE, "utf8")) : undefined;
const mode = selectedBackend();
const audit = new AuditLog();
const backend =
  mode === "mock" ? new MockBackend(fixture, audit)
  : process.platform !== "win32" ? new MockBackend(fixture, audit)
  : new LiveBackend({ endpoint: pipe });
const server = createMcpServer(backend, profile, hardReadOnly, audit);
await server.connect(new StdioServerTransport());
