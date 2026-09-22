import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, decodeFrame, MAX_FRAME_SIZE } from "../src/transport/protocol.js";
import { CircuitBreaker, CircuitState } from "../src/transport/reconnect.js";

test("encodeFrame creates valid frame with length prefix", () => {
  const payload = Buffer.from('{"test": "data"}');
  const frame = encodeFrame(payload);
  assert.equal(frame.length, payload.length + 8);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = Number(view.getBigUint64(0, true));
  assert.equal(length, payload.length);
  assert.ok(Buffer.from(frame.slice(8)).equals(payload));
});

test("decodeFrame parses valid frame", () => {
  const payload = Buffer.from('{"test": "data"}');
  const frame = encodeFrame(payload);
  const result = decodeFrame(frame);
  assert.ok(result !== null);
  assert.ok(result!.payload.equals(payload));
  assert.equal(result!.remaining.length, 0);
});

test("decodeFrame returns null for incomplete frame", () => {
  const payload = Buffer.from('{"test": "data"}');
  const frame = encodeFrame(payload);
  const incomplete = frame.slice(0, frame.length - 5);
  const result = decodeFrame(incomplete);
  assert.equal(result, null);
});

test("decodeFrame throws on oversized frame", () => {
  const oversized = Buffer.alloc(9);
  const view = new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength);
  view.setBigUint64(0, BigInt(MAX_FRAME_SIZE + 1), true);
  assert.throws(() => decodeFrame(oversized), /Invalid frame length/);
});

test("CircuitBreaker starts in CLOSED state", () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.getState(), CircuitState.CLOSED);
});

test("CircuitBreaker opens after failure threshold", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, timeout: 1000 });
  for (let i = 0; i < 3; i++) {
    try { await cb.execute(() => Promise.reject(new Error("fail"))); } catch { }
  }
  assert.equal(cb.getState(), CircuitState.OPEN);
});

test("CircuitBreaker rejects when OPEN", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, timeout: 1000 });
  try { await cb.execute(() => Promise.reject(new Error("fail"))); } catch { }
  await assert.rejects(cb.execute(() => Promise.resolve("ok")), /circuit breaker open/i);
});

test("CircuitBreaker half-opens after timeout", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, timeout: 50 });
  try { await cb.execute(() => Promise.reject(new Error("fail"))); } catch { }
  assert.equal(cb.getState(), CircuitState.OPEN);
  await new Promise(r => setTimeout(r, 60));
  await assert.rejects(cb.execute(() => Promise.reject(new Error("fail"))), /fail/);
  assert.equal(cb.getState(), CircuitState.OPEN);
});