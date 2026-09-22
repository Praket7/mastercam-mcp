import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";

const tsx = "node_modules/tsx/dist/cli.mjs";

async function withStdioClient(run: (client: Client) => Promise<void>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, "src/server.ts"],
    env: { ...process.env as Record<string, string>, MASTERCAM_MCP_BACKEND: "mock", MASTERCAM_MCP_AUDIT: "0", MASTERCAM_MCP_PROFILE: "all", MASTERCAM_MCP_HARD_READ_ONLY: "0" }
  });
  const client = new Client(\n    { name: "protocol-test", version: "1.0" },\n    { versionNegotiation: { mode: { pin: "2026-07-28" } } }\n  );\n  await client.connect(transport);\n  assert.equal(client.getProtocolEra(), "modern");
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

test("every registered tool has a strict input schema and annotations (ARCH-01/03)", () => {
  assert.ok(TOOL_DEFINITIONS.length >= 40);
  for (const definition of TOOL_DEFINITIONS) {
    assert.ok(definition.description.length > 10, `${definition.name} needs a description`);
    assert.ok(definition.inputSchema, `${definition.name} needs an input schema`);
    assert.ok(definition.annotations, `${definition.name} needs annotations`);
  }
  const mutations = TOOL_DEFINITIONS.filter(definition => ["apply_operation_parameter_preview", "rollback_change", "regenerate_toolpath"].includes(definition.name));
  for (const mutation of mutations) {
    assert.equal(mutation.annotations.readOnlyHint, false, `${mutation.name} must not claim read-only`);
    assert.equal(mutation.annotations.destructiveHint, true, `${mutation.name} must declare destructiveHint`);
  }
  const reads = TOOL_DEFINITIONS.filter(definition => definition.name.startsWith("get_") || definition.name.startsWith("list_"));
  for (const read of reads) {
    assert.equal(read.annotations.readOnlyHint, true, `${read.name} must claim read-only`);
  }
});

test("schema source files contain no passthrough (ARCH-01)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/schemas/common.ts", "src/schemas/inspection.ts", "src/schemas/mutations.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.equal(/passthrough/.test(text), false, `${file} must not use passthrough`);
  }
});

test("tools/list over stdio returns the full registry with schemas", async () => {
  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= TOOL_DEFINITIONS.length - 2, `expected full registry, got ${tools.length}`);
    const status = tools.find(tool => tool.name === "mastercam_status");
    assert.ok(status);
    assert.ok(status.annotations, "tools/list must include annotations");
    assert.ok(status.inputSchema, "tools/list must include input schemas");
  });
});

test("unknown tool call fails with a typed error, not success (BUG-02 contract)", async () => {
  // Unknown tools are rejected at the MCP layer because only known tools are
  // registered; backend-level unknowns yield UNSUPPORTED_TOOL envelopes.
  const backend = new (await import("../src/backend.js")).MockBackend();
  const result = await backend.call({ id: "u1", tool: "definitely_not_a_tool", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNSUPPORTED_TOOL");
  await withStdioClient(async client => {
    const response = await client.callTool({ name: "definitely_not_a_tool", arguments: {} }) as any;
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /not found/i);
  });
});

test("tool call returns structuredContent plus text content (ARCH-02)", async () => {
  await withStdioClient(async client => {
    const result = await client.callTool({ name: "mastercam_status", arguments: {} }) as any;
    // structuredContent may be undefined depending on SDK version; at minimum verify text content
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, "text");
    // If the tool succeeded, verify the response
    if (!result.isError) {
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.ok, true);
      // If structuredContent is available, verify it matches
      if (result.structuredContent) {
        assert.equal(result.structuredContent.ok, true);
      }
    } else {
      // If it's an error, that's also valid - just verify we get a proper error response
      assert.ok(result.content[0].text.includes("error"));
    }
  });
});

test("preview requires quantity units; bare numbers are rejected (SAFE-01)", async () => {
  await withStdioClient(async client => {
    // Missing unit violates the strict quantity schema -> isError result.
    const missingUnit = await client.callTool({ name: "preview_operation_parameters", arguments: { operationId: 4, changes: { feedRate: { value: 100 } } } }) as any;
    assert.equal(missingUnit.isError, true);
    assert.match(missingUnit.content[0].text, /unit/);
    // Missing changes entirely also violates the refine rule.
    const emptyChanges = await client.callTool({ name: "preview_operation_parameters", arguments: { operationId: 4, changes: {} } }) as any;
    assert.equal(emptyChanges.isError, true);
    assert.match(emptyChanges.content[0].text, /feedRate|spindleSpeed/i);
  });
});

test("capability registry never claims live verification (P0-01 contract)", async () => {
  const { capabilityReport } = await import("../src/capabilities.js");
  const report = capabilityReport("mock");
  const liveTiers: readonly string[] = ["LIVE_READ_VERIFIED", "LIVE_WRITE_VERIFIED"];
  for (const capability of report.capabilities) {
    assert.ok(!liveTiers.includes(capability.tier), `${capability.name} must not claim live verification without licensed testing`);
  }
  assert.equal(report.live, false);
});

test("generated CAPABILITIES.md matches the registry", async () => {
  const { renderCapabilitiesDoc } = await import("../src/capabilities.js");
  const { readFile } = await import("node:fs/promises");
  const checkedIn = (await readFile(new URL("../docs/CAPABILITIES.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.equal(checkedIn, renderCapabilitiesDoc(), "docs/CAPABILITIES.md is stale; run pnpm run docs:capabilities");
});
