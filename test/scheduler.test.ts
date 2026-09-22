import test from "node:test";
import assert from "node:assert/strict";
import { RequestScheduler } from "../src/scheduler/request-scheduler.js";
import { KeyedLock } from "../src/scheduler/locks.js";

test("scheduler processes read requests with concurrency limit", async () => {
  const scheduler = new RequestScheduler({ maxConcurrentReads: 2 });
  let active = 0;
  let maxActive = 0;

  const promises = Array.from({ length: 5 }, (_, i) =>
    scheduler.schedule("read", `key-${i}`, "normal", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return i;
    })
  );

  const results = await Promise.all(promises);
  assert.deepEqual(results.sort(), [0, 1, 2, 3, 4]);
  assert.ok(maxActive <= 2);
});

test("scheduler serializes mutations per key", async () => {
  const scheduler = new RequestScheduler({ maxConcurrentMutations: 1 });
  const order: number[] = [];

  await scheduler.schedule("mutation", "same-key", "normal", async () => { order.push(1); await new Promise(r => setTimeout(r, 10)); order.push(2); });
  await scheduler.schedule("mutation", "same-key", "normal", async () => { order.push(3); await new Promise(r => setTimeout(r, 10)); order.push(4); });
  await scheduler.schedule("mutation", "other-key", "normal", async () => { order.push(5); });

  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test("scheduler prioritizes critical over normal", async () => {
  const scheduler = new RequestScheduler({ maxConcurrentReads: 1 });
  const order: string[] = [];

  scheduler.schedule("read", "low", "low", async () => { order.push("low"); });
  scheduler.schedule("read", "normal", "normal", async () => { order.push("normal"); });
  scheduler.schedule("read", "high", "high", async () => { order.push("high"); });
  scheduler.schedule("read", "critical", "critical", async () => { order.push("critical"); });

  await new Promise(r => setTimeout(r, 50));
  assert.equal(order[0], "critical");
  assert.equal(order[1], "high");
  assert.equal(order[2], "normal");
  assert.equal(order[3], "low");
});

test("KeyedLock provides mutual exclusion per key", async () => {
  const lock = new KeyedLock();
  const order: string[] = [];

  const p1 = lock.withLock("key1", async () => { order.push("a1"); await new Promise(r => setTimeout(r, 10)); order.push("a2"); });
  const p2 = lock.withLock("key1", async () => { order.push("b1"); await new Promise(r => setTimeout(r, 10)); order.push("b2"); });
  const p3 = lock.withLock("key2", async () => { order.push("c1"); });

  await Promise.all([p1, p2, p3]);
  // Per-key mutual exclusion: a1 before a2 before b1 before b2
  assert.ok(order.indexOf("a1") < order.indexOf("a2"));
  assert.ok(order.indexOf("a2") < order.indexOf("b1"));
  assert.ok(order.indexOf("b1") < order.indexOf("b2"));
  assert.ok(order.includes("c1"));
});

test("scheduler reports stats", async () => {
  const scheduler = new RequestScheduler({ maxConcurrentReads: 2, maxConcurrentMutations: 1 });
  const stats = scheduler.getStats();
  assert.equal(stats.read.max, 2);
  assert.equal(stats.mutation.max, 1);
  assert.equal(stats.read.queued, 0);
  assert.equal(stats.mutation.queued, 0);
});