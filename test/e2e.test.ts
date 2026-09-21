import * as fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { BridgeClient } from "../src/transport/bridge-client.js";
import { LiveBackend } from "../src/live-backend.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createMockV2Server(socketPath: string, handler: (req: any) => any) {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const len = Number(buffer.readBigUInt64LE(0));
        if (buffer.length < 8 + len) break;
        const payload = buffer.subarray(8, 8 + len);
        buffer = buffer.subarray(8 + len);
        try {
          const req = JSON.parse(payload.toString("utf8"));
          const res = handler(req);
          const resPayload = Buffer.from(JSON.stringify({
            protocolVersion: 2,
            requestId: req.requestId,
            type: "response",
            result: res,
            adapterVersion: "test-0.0.1",
            mastercamVersion: "2026"
          }), "utf8");
          const frame = Buffer.alloc(8 + resPayload.length);
          frame.writeBigUInt64LE(BigInt(resPayload.length), 0);
          resPayload.copy(frame, 8);
          socket.write(frame);
        } catch (e) {
          const errPayload = Buffer.from(JSON.stringify({
            protocolVersion: 2,
            requestId: "unknown",
            type: "error",
            error: { code: "INVALID_JSON", message: String(e), retryable: false }
          }), "utf8");
          const frame = Buffer.alloc(8 + errPayload.length);
          frame.writeBigUInt64LE(BigInt(errPayload.length), 0);
          errPayload.copy(frame, 8);
          socket.write(frame);
        }
      }
    });
  });
  return server;
}

test("e2e: LiveBackend -> Bridge-v2 mock native", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\mastercam-mcp-e2e-${process.pid}-${Date.now()}` : join(tmpdir(), `e2e-mcp-${process.pid}-${Date.now()}.sock`);
  try { if (process.platform !== "win32") fs.unlinkSync(socketPath); } catch {}
  const server = createMockV2Server(socketPath, (_req) => {
    if (_req.tool === "mastercam_status") return { ok: true, tool: _req.tool, data: { connected: true, backend: "mock-v2" } };
    if (_req.tool === "get_active_part") return { ok: true, tool: _req.tool, data: { name: "e2e-part", path: "e2e://part", units: "mm", modified: false, revision: "rev-e2e", fingerprint: "abc" } };
    if (_req.tool === "preview_operation_parameters") {
      return { ok: true, tool: _req.tool, data: { before: { feedRate: { value: 100, unit: "mm/min" } }, after: { feedRate: { value: 200, unit: "mm/min" } }, approvalToken: "e2e-token", expiresAt: new Date(Date.now()+300000).toISOString(), documentRevision: "rev-e2e", operationFingerprint: "fp-e2e", requiresRegeneration: true, rollbackAvailable: true, risks: [] } };
    }
    return { ok: false, tool: _req.tool, error: { code: "UNSUPPORTED_TOOL", message: "not implemented in e2e mock" } };
  });
  await new Promise<void>((res, rej) => { server.listen(socketPath, res); server.on("error", rej); });

  const backend = new LiveBackend({ endpoint: socketPath });
  const status = await backend.call({ id: "e2e-1", tool: "mastercam_status", arguments: {} });
  assert.equal(status.ok, true);
  assert.equal((status.data as any).backend, "mock-v2");

  const part = await backend.call({ id: "e2e-2", tool: "get_active_part", arguments: {} });
  assert.equal(part.ok, true);
  assert.equal((part.data as any).name, "e2e-part");

  const preview = await backend.call({ id: "e2e-3", tool: "preview_operation_parameters", arguments: { operationId: 1, changes: { feedRate: { value: 200, unit: "mm/min" } } } });
  assert.equal(preview.ok, true);
  assert.ok((preview.data as any).approvalToken);

  await backend.close();
  await new Promise<void>(res => server.close(() => res()));
  try { fs.unlinkSync(socketPath); } catch {}
});

test("e2e: BridgeClient cancellation", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\mastercam-mcp-e2e-cancel-${process.pid}-${Date.now()}` : join(tmpdir(), `e2e-cancel-${process.pid}-${Date.now()}.sock`);
  try { if (process.platform !== "win32") fs.unlinkSync(socketPath); } catch {}
  const server = createMockV2Server(socketPath, (_req) => {
    // never respond to test cancellation
    return new Promise(() => {});
  });
  await new Promise<void>((res, rej) => { server.listen(socketPath, res); server.on("error", rej); });
  const client = new BridgeClient({ endpoint: socketPath });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(
    client.call("long_op", {}, 5000, ac.signal),
    (err: Error) => err.message.includes("CANCELLED")
  );
  await client.close();
  await new Promise<void>(res => server.close(() => res()));
  try { fs.unlinkSync(socketPath); } catch {}
});
