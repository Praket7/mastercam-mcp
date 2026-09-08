import test from "node:test";
import assert from "node:assert/strict";
import { MockBackend } from "../src/backend.js";
import { doctor } from "../src/diagnostics.js";

test("fixture backend supports inspect, measure, assert, preview, and rollback", async () => {
  const backend = new MockBackend({ feed: 37 });
  assert.equal(((await backend.call({ id: "1", tool: "measure", arguments: {} })) as any).data.value, 37);
  assert.equal(((await backend.call({ id: "2", tool: "assert", arguments: { equals: 37 } })) as any).data.pass, true);
  assert.equal(((await backend.call({ id: "3", tool: "preview_change", arguments: { feed: 44 } })) as any).data.after.feed, 44);
  assert.equal(((await backend.call({ id: "4", tool: "rollback_change", arguments: { beforeFeed: 31 } })) as any).receipt.after.feed, 31);
});

test("doctor reports mock prerequisites without a Mastercam license", async () => {
  const result = await doctor("\\\\.\\pipe\\mastercam-mcp-default", "mock");
  assert.equal(result.ok, true);
  assert.equal((result.data as any).checks.pipe.ok, true);
});
