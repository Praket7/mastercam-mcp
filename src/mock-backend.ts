import net from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { MockBackend } from "./backend.js";
import { defaultPipe } from "./platform.js";
import { FrameReader } from "./transport/framing.js";
import { encodeFrame } from "./transport/protocol.js";

const pipe = process.env.MASTERCAM_MCP_PIPE ?? defaultPipe();
const backend = new MockBackend();
const readers = new WeakMap<net.Socket, FrameReader>();
const MAX_REQUEST_BYTES = 1024 * 1024;

if (process.platform !== "win32" && !pipe.startsWith("\\\\")) {
  mkdirSync(dirname(pipe), { recursive: true });
  try { rmSync(pipe, { force: true }); } catch { }
}

const server = net.createServer(socket => {
  const reader = new FrameReader(MAX_REQUEST_BYTES);
  readers.set(socket, reader);
  socket.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = reader.push(chunk);
    } catch (error) {
      socket.write(encodeFrame(JSON.stringify({
        protocolVersion: 2,
        requestId: "",
        type: "error",
        ok: false,
        tool: "",
        error: {
          code: "REQUEST_TOO_LARGE",
          message: error instanceof Error ? error.message : String(error)
        }
      })));
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (!frame.trim()) continue;
      void handleFrame(socket, frame);
    }
  });
});

async function handleFrame(socket: net.Socket, frame: string): Promise<void> {
  try {
    const req = JSON.parse(frame) as {
      type?: string;
      protocolVersion?: number;
      requestId?: string;
      tool?: string;
      arguments?: Record<string, unknown>;
    };
    if (req.type === "cancel") return;
    if (req.type !== "request" || req.protocolVersion !== 2 || !req.requestId || !req.tool) {
      throw new Error("INVALID_REQUEST: bridge-v2 request requires type=request, protocolVersion=2, requestId and tool");
    }
    const result = await backend.call({
      id: req.requestId,
      tool: req.tool,
      arguments: req.arguments ?? {}
    });
    const response = {
      protocolVersion: 2,
      requestId: req.requestId,
      type: result.ok ? "response" : "error",
      ok: result.ok,
      tool: req.tool,
      data: result.data,
      error: result.error,
      receipt: result.receipt,
      live: false,
      documentRevision: result.documentRevision
    };
    if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(response)));
  } catch (error) {
    if (!socket.destroyed) {
      socket.write(encodeFrame(JSON.stringify({
        protocolVersion: 2,
        requestId: "",
        type: "error",
        ok: false,
        tool: "",
        error: {
          code: "INVALID_JSON",
          message: error instanceof Error ? error.message : String(error)
        }
      })));
    }
  }
}

server.listen(pipe, () => console.error(`Mock Mastercam backend listening on ${pipe}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      if (process.platform !== "win32" && !pipe.startsWith("\\\\")) {
        try { rmSync(pipe, { force: true }); } catch { }
      }
      process.exit(0);
    });
  });
}
