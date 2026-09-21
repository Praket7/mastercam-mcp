// @ts-nocheck
import { MockBackend } from "./backend.js";
import { defaultPipe } from "./platform.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pipe = process.env["MASTERCAM_MCP_PIPE"] ?? defaultPipe();
const backend = new MockBackend();

const net = require("node:net") as any;

function createServer() {
  if (process.platform === "win32") {
    return net.createServer((socket: any) => handleSocket(socket));
  }
  const socketPath = pipe.endsWith(".sock") ? pipe : join(tmpdir(), `mastercam-mcp-${process.getuid()}.sock`);
  return net.createServer((socket: any) => handleSocket(socket));
}

function handleSocket(socket: any) {
  socket.setEncoding("utf8");
  let buffer = "";
  const MAX_BUFFER = 8 * 1024 * 1024;
  socket.on("data", async (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      socket.write(JSON.stringify({ id: "unknown", result: { ok: false, error: { code: "BUFFER_EXCEEDED", message: "Request buffer exceeded maximum size" } } }) + "\n");
      buffer = "";
      return;
    }
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line);
        const result = await backend.call(req);
        socket.write(JSON.stringify({ id: req.id, result }) + "\n");
      } catch (e) {
        socket.write(JSON.stringify({ id: "unknown", result: { ok: false, error: { code: "BAD_REQUEST", message: String(e) } } }) + "\n");
      }
    }
  });
}

const server = createServer();

function getSocketPath(): string {
  if (process.platform === "win32") return pipe;
  return pipe.endsWith(".sock") ? pipe : join(tmpdir(), `mastercam-mcp-${process.getuid()}.sock`);
}

const socketPath = getSocketPath();
server.listen(socketPath);
server.on("listening", () => {
  console.error(`Mock Mastercam backend listening on ${socketPath}`);
});

if (process.platform !== "win32") {
  process.on("exit", () => {
    try { require("node:fs").unlinkSync(socketPath); } catch { }
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}