import test from "node:test";
import assert from "node:assert/strict";
import { FrameReader } from "../src/transport/framing.js";
import { encodeFrame } from "../src/transport/protocol.js";
import { Scheduler } from "../src/scheduler/request-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("FrameReader decodes arbitrarily fragmented and back-to-back frames", () => {
  const reader = new FrameReader();
  const messages = [
    JSON.stringify({ id: 1, value: "a".repeat(4096) }),
    JSON.stringify({ id: 2, value: "b".repeat(31) }),
    JSON.stringify({ id: 3, value: "done" })
  ];
  const wire = Buffer.concat(messages.map(message => Buffer.from(encodeFrame(message))));
  const decoded: string[] = [];
  for (let index = 0; index < wire.length; index++) {
    decoded.push(...reader.push(wire.subarray(index, index + 1)));
  }
  assert.deepEqual(decoded, messages);
  assert.equal(reader.pendingBytes, 0);
});

test("scheduler uses real priority ordering without artificial sleeps", async () => {
  const scheduler = new Scheduler({ maxConcurrentReads: 1 });
  const gate = deferred();
  const order: string[] = [];

  const first = scheduler.schedule("read", "doc", "normal", async () => {
    order.push("first");
    await gate.promise;
  });
  const low = scheduler.schedule("read", "doc", "low", async () => { order.push("low"); });
  const critical = scheduler.schedule("read", "doc", "critical", async () => { order.push("critical"); });

  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, low, critical]);
  assert.deepEqual(order, ["first", "critical", "low"]);
});

test("scheduler refuses unsafe mutation concurrency configuration", () => {
  assert.throws(
    () => new Scheduler({ maxConcurrentMutations: 2 }),
    /maxConcurrentMutations must be 1/
  );
});
