import * as fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { BridgeClient } from "../src/transport/bridge-client.js";
import { LiveBackend } from "../src/live-backend.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface MockBridgeResult {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    })
  ]);
}

function createMockV2Server(
  socketPath: string,
  handler: (req: Record<string, unknown>) => MockBridgeResult | undefined
) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const len = Number(buffer.readBigUInt64LE(0));
        if (!Number.isSafeInteger(len) || len < 0 || len > 16 * 1024 * 1024) {
          socket.destroy(new Error("invalid frame length"));
          return;
        }
        if (buffer.length < 8 + len) break;
        const payload = buffer.subarray(8, 8 + len);
        buffer = buffer.subarray(8 + len);

        try {
          const req = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
          if (req.type === "cancel") continue;
          const result = handler(req);
          if (!result) continue;

          const resPayload = Buffer.from(JSON.stringify({
            protocolVersion: 2,
            requestId: String(req.requestId ?? ""),
            type: result.ok ? "response" : "error",
            ...result,
            adapterVersion: "test-0.0.1",
            mastercamVersion: "2026",
            live: true,
            durationMs: 1
          }), "utf8");
          const frame = Buffer.alloc(8 + resPayload.length);
          frame.writeBigUInt64LE(BigInt(resPayload.length), 0);
          resPayload.copy(frame, 8);
          socket.write(frame);
        } catch (error) {
          const errPayload = Buffer.from(JSON.stringify({
            protocolVersion: 2,
            requestId: "unknown",
            type: "error",
            ok: false,
            tool: "unknown",
            error: { code: "INVALID_JSON", message: String(error), retryable: false },
            live: true
          }), "utf8");
          const frame = Buffer.alloc(8 + errPayload.length);
          frame.writeBigUInt64LE(BigInt(errPayload.length), 0);
          errPayload.copy(frame, 8);
          socket.write(frame);
        }
      }
    });
  });

  return { server, sockets, socketPath };
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  }), 5000, "mock bridge listen");
}

async function closeMockServer(
  server: net.Server,
  sockets: Set<net.Socket>,
  socketPath: string
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await withTimeout(new Promise<void>(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  }), 5000, "mock bridge close").catch(() => undefined);
  try {
    if (process.platform !== "win32") fs.unlinkSync(socketPath);
  } catch {
    // already removed
  }
}

function uniqueSocketPath(prefix: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${prefix}-${process.pid}-${Date.now()}`
    : join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}.sock`);
}

test("e2e: LiveBackend -> Bridge-v2 mock native", async () => {
  const socketPath = uniqueSocketPath("mastercam-mcp-e2e");
  try {
    if (process.platform !== "win32") fs.unlinkSync(socketPath);
  } catch {
    // absent is expected
  }

  const mock = createMockV2Server(socketPath, req => {
    const tool = String(req.tool ?? "");
    if (tool === "mastercam_status") {
      return {
        ok: true,
        tool,
        data: { connected: true, backend: "mock-v2", adapter: "test-0.0.1", runtime: "test", mastercamVersion: "2026", protocolVersion: 2 }
      };
    }
    if (tool === "get_active_part") {
      return {
        ok: true,
        tool,
        data: { name: "e2e-part", path: "e2e://part", units: "mm", modified: false, documentRevision: "rev-e2e" }
      };
    }
    if (tool === "preview_operation_parameters") {
      return {
        ok: true,
        tool,
        data: {
          operationId: 1,
          before: { feedRate: { value: 100, unit: "mm/min" } },
          after: { feedRate: { value: 200, unit: "mm/min" } },
          approvalToken: "e2e-token",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          documentRevision: "rev-e2e",
          operationFingerprint: "fp-e2e",
          requiresRegeneration: true,
          risks: []
        }
      };
    }
    return {
      ok: false,
      tool,
      error: { code: "UNSUPPORTED_TOOL", message: "not implemented in e2e mock", retryable: false }
    };
  });

  let backend: LiveBackend | undefined;
  try {
    await listen(mock.server, socketPath);
    backend = new LiveBackend({ endpoint: socketPath });

    const status = await withTimeout(
      backend.call({ id: "e2e-1", tool: "mastercam_status", arguments: {} }),
      5000,
      "e2e status"
    );
    assert.equal(status.ok, true);
    assert.equal((status.data as { backend?: string }).backend, "mock-v2");

    const part = await withTimeout(
      backend.call({ id: "e2e-2", tool: "get_active_part", arguments: {} }),
      5000,
      "e2e active part"
    );
    assert.equal(part.ok, true);
    assert.equal((part.data as { name?: string }).name, "e2e-part");

    const preview = await withTimeout(
      backend.call({
        id: "e2e-3",
        tool: "preview_operation_parameters",
        arguments: { operationId: 1, changes: { feedRate: { value: 200, unit: "mm/min" } } }
      }),
      5000,
      "e2e preview"
    );
    assert.equal(preview.ok, true);
    assert.ok((preview.data as { approvalToken?: string }).approvalToken);
  } finally {
    await backend?.close().catch(() => undefined);
    await closeMockServer(mock.server, mock.sockets, socketPath);
  }
});

test("e2e: BridgeClient cancellation", async () => {
  const socketPath = uniqueSocketPath("mastercam-mcp-e2e-cancel");
  try {
    if (process.platform !== "win32") fs.unlinkSync(socketPath);
  } catch {
    // absent is expected
  }

  const mock = createMockV2Server(socketPath, () => undefined);
  let client: BridgeClient | undefined;
  try {
    await listen(mock.server, socketPath);
    client = new BridgeClient({ endpoint: socketPath });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    timer.unref?.();

    await assert.rejects(
      withTimeout(client.call("long_op", {}, 5000, controller.signal), 3000, "cancelled bridge call"),
      (error: Error) => error.message.includes("CANCELLED")
    );
  } finally {
    await client?.close().catch(() => undefined);
    await closeMockServer(mock.server, mock.sockets, socketPath);
  }
});
