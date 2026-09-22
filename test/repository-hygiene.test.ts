import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("runtime audit logs are never tracked in source control", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  const auditArtifacts = tracked.filter(path => /(^|\/)audit[^/]*\.jsonl$/i.test(path));
  assert.deepEqual(
    auditArtifacts,
    [],
    `runtime audit artifacts must not be committed: ${auditArtifacts.join(", ")}`
  );
});
