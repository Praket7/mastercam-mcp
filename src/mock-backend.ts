import net from "node:net";
import { rmSync } from "node:fs";
import { MockBackend } from "./backend.js";
import { defaultPipe } from "./platform.js";
import { FrameReader } from "./transport/framing.js";

const pipe = process.env.MASTERCAM_MCP_PIPE ?? defaultPipe();
const backend = new MockBackend();
const readers = new WeakMap<net.Socket, FrameReader>();
const MAX_REQUEST_BYTES = 1024 * 1024;

// On Unix a stale socket file from a previous run would make listen() fail.
if (process.platform !== "win32" && !pipe.startsWith("\\\\")) {
  try { rmSync(pipe, { force: true }); } catch { /* best effort */ }
}

const server = net.createServer(socket => {
  const reader = new FrameReader(MAX_REQUEST_BYTES);
  readers.set(socket, reader);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let frames: string[];
    try { frames = reader.push(chunk); }
    catch (error) {
      // Oversized request: answer with an explicit failure and drop the link.
      socket.write(`${JSON.stringify({ id: null, result: { ok: false, error: { code: "REQUEST_TOO_LARGE", message: error instanceof Error ? error.message : String(error) } } })}\n`);
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (!frame.trim()) continue;
      void handleFrame(socket, frame);
    }
  });
});

async function handleFrame(socket: net.Socket, frame: string) {
  let response: string;
  try {
    const req = JSON.parse(frame) as { id?: unknown; tool?: unknown; arguments?: Record<string, unknown> };
    const result = await backend.call({ id: String(req.id ?? ""), tool: String(req.tool ?? ""), arguments: req.arguments ?? {} });
    response = `${JSON.stringify({ id: req.id ?? null, result })}\n`;
  } catch (error) {
    response = `${JSON.stringify({ id: null, result: { ok: false, error: { code: "INVALID_JSON", message: error instanceof Error ? error.message : String(error) } } })}\n`;
  }
  if (!socket.destroyed) socket.write(response);
}

server.listen(pipe, () => console.error(`Mock Mastercam backend listening on ${pipe}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      if (process.platform !== "win32" && !pipe.startsWith("\\\\")) {
        try { rmSync(pipe, { force: true }); } catch { /* best effort */ }
      }
      process.exit(0);
    });
  });
}
