import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as z from "zod/v4";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";

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

test("registered MCP tools have stable names, useful descriptions, and documented top-level inputs", () => {
  const names = TOOL_DEFINITIONS.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");

  for (const tool of TOOL_DEFINITIONS) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, `${tool.name} must use lowercase snake_case`);
    assert.ok(tool.description.trim().length >= 24, `${tool.name} needs a useful description`);

    const schema = z.toJSONSchema(tool.inputSchema, { unrepresentable: "any" }) as {
      properties?: Record<string, { description?: string }>;
      oneOf?: Array<{ properties?: Record<string, { description?: string }> }>;
      anyOf?: Array<{ properties?: Record<string, { description?: string }> }>;
    };
    const variants = schema.oneOf ?? schema.anyOf ?? [schema];
    for (const variant of variants) {
      for (const [name, property] of Object.entries(variant.properties ?? {})) {
        assert.ok(
          property.description?.trim(),
          `${tool.name}.${name} needs an input description so clients can choose valid arguments`
        );
      }
    }
  }
});
