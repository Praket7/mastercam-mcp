import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { FrameReader, encodeFrame } from "../src/transport/framing.js";
import { CircuitBreaker } from "../src/transport/circuit-breaker.js";
import { withRetry } from "../src/transport/reconnect.js";
import { parseFrame, encodeRequest } from "../src/transport/bridge-protocol.js";

test("frame reader drains multiple frames from one chunk (BUG-11)", () => {
  const reader = new FrameReader();
  const frames = reader.push('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("frame reader reassembles fragmented frames", () => {
  const reader = new FrameReader();
  assert.deepEqual(reader.push('{"to'), []);
  assert.deepEqual(reader.push('ol":"x"}\n'), ['{"tool":"x"}']);
  assert.deepEqual(reader.push('{"second":true}\n'), ['{"second":true}']);
});

test("frame reader rejects oversized frames before allocation completes", () => {
  const reader = new FrameReader(64);
  assert.throws(() => reader.push(`${"x".repeat(100)}\n`), /RESPONSE_TOO_LARGE/);
});

test("frame reader rejects unbounded partial data", () => {
  const reader = new FrameReader(32);
  reader.push("short");
  assert.throws(() => reader.push("x".repeat(64)), /RESPONSE_TOO_LARGE/);
});

test("encodeFrame enforces the request bound", () => {
  assert.throws(() => encodeFrame("x".repeat(5 * 1024 * 1024)), /REQUEST_TOO_LARGE/);
});

test("bridge protocol round-trips requests and tags events", () => {
  const encoded = encodeRequest({ protocolVersion: 2, requestId: "r1", tool: "t" });
  const parsed = parseFrame(encoded);
  assert.equal(parsed.kind, "response");
  assert.equal((parsed as any).response.requestId, "r1");
  const event = parseFrame('{"type":"event","event":"document_changed"}');
  assert.equal(event.kind, "event");
});

test("circuit breaker opens after repeated failures and recovers", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 20, halfOpenSuccesses: 1 });
  const failing = () => Promise.reject(new Error("down"));
  await assert.rejects(() => breaker.execute(failing));
  assert.equal(breaker.currentState, "CLOSED");
  await assert.rejects(() => breaker.execute(failing));
  await assert.rejects(() => breaker.execute(failing));
  assert.equal(breaker.currentState, "OPEN");
  // While open, calls fail fast without reaching the endpoint.
  await assert.rejects(() => breaker.execute(failing), /circuit breaker open/);
  await new Promise(resolve => setTimeout(resolve, 30));
  // After cooldown, a success closes the breaker.
  const value = await breaker.execute(() => Promise.resolve(42));
  assert.equal(value, 42);
  assert.equal(breaker.currentState, "CLOSED");
});

test("retry never retries non-idempotent operations (REL-03)", async () => {
  let mutationAttempts = 0;
  await assert.rejects(() => withRetry({ idempotent: false }, () => {
    mutationAttempts++;
    return Promise.reject(new Error("lost"));
  }));
  assert.equal(mutationAttempts, 1);
});

test("retry retries idempotent reads until success (REL-03)", async () => {
  let attempts = 0;
  const value = await withRetry({ idempotent: true, maxAttempts: 3, baseDelayMs: 1 }, () => {
    attempts++;
    if (attempts < 3) return Promise.reject(new Error("flaky"));
    return Promise.resolve("ok");
  });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("mock transport over a unix socket handles fragmented and batched frames", async () => {
  if (process.platform === "win32") return; // named pipes covered on Windows CI
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const socketPath = path.join(os.tmpdir(), `mcam-test-${Date.now()}.sock`);
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/mock-backend.ts"], {
    env: { ...process.env, MASTERCAM_MCP_PIPE: socketPath, MASTERCAM_MCP_AUDIT: "0" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  try {
    await waitFor(() => fs.existsSync(socketPath), 5000);
    const socket = net.createConnection(socketPath);
    await new Promise<void>(resolve => socket.once("connect", resolve));
    const reader = new FrameReader();
    const responses: any[] = [];
    socket.setEncoding("utf8");
    socket.on("data", chunk => { for (const frame of reader.push(chunk)) responses.push(JSON.parse(frame)); });
    // Two requests in a single write: both must be answered (BUG-11).
    socket.write(JSON.stringify({ id: "a", tool: "mastercam_status" }) + "\n" + JSON.stringify({ id: "b", tool: "list_operations" }) + "\n");
    // A third request fragmented across two writes.
    const requestC = JSON.stringify({ id: "c", tool: "get_active_part" }) + "\n";
    socket.write(requestC.slice(0, 12));
    socket.write(requestC.slice(12));
    await waitFor(() => responses.length >= 3, 5000);
    assert.equal(responses[0].id, "a");
    assert.equal(responses[0].result.ok, true);
    assert.equal(responses[1].id, "b");
    assert.equal(responses[2].id, "c");
    assert.equal(responses[2].result.ok, true);
    // Malformed frame between valid frames yields one INVALID_JSON error
    // response and does not kill the connection (audit BUG-11/section 46).
    socket.write("not json\n");
    socket.write(JSON.stringify({ id: "d", tool: "mastercam_status" }) + "\n");
    await waitFor(() => responses.some(response => response.id === "d"), 5000);
    assert.equal(responses[responses.length - 1].id, "d");
    const invalid = responses.find(response => response.id === null && response.result?.ok === false);
    assert.ok(invalid, "malformed frame must produce a typed error response");
    assert.equal(invalid.result.error.code, "INVALID_JSON");
    socket.destroy();
  } finally {
    child.kill();
    try { fs.rmSync(socketPath, { force: true }); } catch { /* cleanup */ }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}
