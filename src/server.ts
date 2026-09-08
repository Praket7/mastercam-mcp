import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MockBackend, PipeBackend } from "./backend.js";
import { createMcpServer } from "./mcp.js";

const profile = (process.env.MASTERCAM_MCP_PROFILE ?? "read") as any;
const hardReadOnly = process.env.MASTERCAM_MCP_HARD_READ_ONLY !== "0";
const pipe = process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default";
const backend = process.env.MASTERCAM_MCP_BACKEND === "mock" ? new MockBackend() : new PipeBackend(pipe);
const server = createMcpServer(backend, profile, hardReadOnly);
await server.connect(new StdioServerTransport());
