import net from "node:net";
import { rmSync } from "node:fs";
import { MockBackend } from "./backend.js";
import { defaultPipe } from "./platform.js";
import { FrameReader } from "./transport/framing.js";

const pipe = process.env.MASTERCAM_MCP_PIPE ?? defaultPipe();
const backend = new MockBackend();
const readers = new WeakMap<net.Socket, FrameReader>();
const MAX_REQUEST_BYTES = 1024 * 1024;

if (process.platform !== "win32" && !pipe.startsWith("\\\\")) {
    try {
        rmSync(pipe, { force: true });
    }
    catch { }
}

const server = net.createServer((socket) => {
    const reader = new FrameReader(MAX_REQUEST_BYTES);
    readers.set(socket, reader);
    socket.on("data", (chunk: Buffer) => {
        let frames: string[];
        try {
            frames = reader.push(chunk);
        }
        catch (error) {
            const response = encodeFrame(JSON.stringify({
                id: null,
                result: {
                    ok: false,
                    error: {
                        code: "REQUEST_TOO_LARGE",
                        message: error instanceof Error ? error.message : String(error)
                    }
                }
            }));
            socket.write(response);
            socket.destroy();
            return;
        }
        for (const frame of frames) {
            if (!frame.trim()) continue;
            void handleFrame(socket, frame);
        }
    });
});

function encodeFrame(payload: string): Buffer {
    const buf = Buffer.from(payload, "utf8");
    const frame = Buffer.alloc(8 + buf.length);
    frame.writeBigUInt64LE(BigInt(buf.length), 0);
    buf.copy(frame, 8);
    return frame;
}

async function handleFrame(socket: net.Socket, frame: string): Promise<void> {
    let response: Buffer;
    try {
        const req = JSON.parse(frame);
        const result = await backend.call({
            id: String(req.id ?? ""),
            tool: String(req.tool ?? ""),
            arguments: req.arguments ?? {}
        });
        response = encodeFrame(JSON.stringify({ id: req.id ?? null, result }));
    }
    catch (error) {
        response = encodeFrame(JSON.stringify({
            id: null,
            result: {
                ok: false,
                error: {
                    code: "INVALID_JSON",
                    message: error instanceof Error ? error.message : String(error)
                }
            }
        }));
    }
    if (!socket.destroyed) {
        socket.write(response);
    }
}

server.listen(pipe, () => console.error(`Mock Mastercam backend listening on ${pipe}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.close(() => {
            if (process.platform !== "win32" && !pipe.startsWith("\\\\")) {
                try {
                    rmSync(pipe, { force: true });
                }
                catch { }
            }
            process.exit(0);
        });
    });
}