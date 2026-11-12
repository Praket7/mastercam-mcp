import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";
import { SUPPORTED_PROTOCOL_REVISIONS, CURRENT_PROTOCOL_REVISION } from "../src/contracts.js";

const tsx = "node_modules/tsx/dist/cli.mjs";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    })
  ]);
}

async function withStdioClient(
  run: (client: Client) => Promise<void>,
  extraEnv: Record<string, string> = {},
  operatorApproval = false,
  protocolVersion = CURRENT_PROTOCOL_REVISION
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, "src/server.ts"],
    env: {
      ...(process.env as Record<string, string>),
      MASTERCAM_MCP_BACKEND: "mock",
      MASTERCAM_MCP_AUDIT: "0",
      MASTERCAM_MCP_PROFILE: "all",
      MASTERCAM_MCP_HARD_READ_ONLY: "0",
      MASTERCAM_MCP_TOOLSET: "full",
      ...extraEnv
    }
  });
  const client = new Client(
    { name: "protocol-test", version: "1.0" },
    {
      supportedProtocolVersions: [protocolVersion],
      versionNegotiation: protocolVersion === CURRENT_PROTOCOL_REVISION
        ? { mode: { pin: protocolVersion } }
        : { mode: "legacy" },
      ...(operatorApproval ? { capabilities: { elicitation: { form: {} } } } : {})
    }
  );
  if (operatorApproval) {
    client.setRequestHandler("elicitation/create", async request => {
      assert.match(request.params.message, /Before:.*After:/s);
      assert.match(request.params.message, /Document revision/);
      return { action: "accept", content: { confirm: true } };
    });
  }

  await withTimeout(client.connect(transport), 15_000, "stdio MCP connect");
  if (protocolVersion === CURRENT_PROTOCOL_REVISION) {
    assert.equal(client.getProtocolEra(), "modern");
  }
  try {
    await withTimeout(run(client), 30_000, "stdio MCP test body");
  } finally {
    await withTimeout(client.close(), 5_000, "stdio MCP client close").catch(() => undefined);
    await withTimeout(transport.close(), 5_000, "stdio transport close").catch(() => undefined);
  }
}

test("OD planning uses configured ISO catalog records when tool inputs are omitted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mastercam-od-catalog-"));
  const path = join(directory, "catalog.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "1.1",
    publisher: "Test Toolmaker",
    tools: [
      { toolNbr: "ROUGH-1", name: "OD rough insert", toolTypes: ["turning rough"], specs: {} },
      { toolNbr: "FINISH-1", name: "OD finish insert", toolTypes: ["turning finish"], specs: {} }
    ]
  }));
  try {
    await withStdioClient(async client => {
      const result = await client.callTool({
        name: "plan_od_rough_finish",
        arguments: {
          intent: "Rough and finish this OD profile",
          units: "mm",
          material: "4140",
          stockDiameter: 30,
          profile: [{ z: 0, diameter: 20 }, { z: -40, diameter: 24 }],
          finishAllowanceRadial: 0.2,
          roughDepthRadial: 1
        }
      });
      assert.notEqual(result.isError, true, result.content[0] && "text" in result.content[0] ? result.content[0].text : "");
      const data = (result.structuredContent as { data?: { toolSelection?: { rough?: { toolId?: string }; finish?: { toolId?: string } } } }).data;
      assert.equal(data?.toolSelection?.rough?.toolId, "ROUGH-1");
      assert.equal(data?.toolSelection?.finish?.toolId, "FINISH-1");
    }, { MASTERCAM_MCP_TOOL_LIBRARY: path });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every registered tool has a strict input schema and annotations (ARCH-01/03)", () => {
  assert.ok(TOOL_DEFINITIONS.length >= 40);
  for (const definition of TOOL_DEFINITIONS) {
    assert.ok(definition.description.length > 10, `${definition.name} needs a description`);
    assert.ok(definition.inputSchema, `${definition.name} needs an input schema`);
    assert.ok(definition.annotations, `${definition.name} needs annotations`);
  }
  const mutations = TOOL_DEFINITIONS.filter(definition =>
    ["apply_operation_parameter_preview", "rollback_change"].includes(definition.name)
  );
  for (const mutation of mutations) {
    assert.equal(mutation.annotations.readOnlyHint, false, `${mutation.name} must not claim read-only`);
    assert.equal(mutation.annotations.destructiveHint, true, `${mutation.name} must declare destructiveHint`);
  }
  const reads = TOOL_DEFINITIONS.filter(definition =>
    definition.name.startsWith("get_") || definition.name.startsWith("list_")
  );
  for (const read of reads) {
    assert.equal(read.annotations.readOnlyHint, true, `${read.name} must claim read-only`);
  }
});

test("schema source files contain no passthrough (ARCH-01)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/schemas/common.ts", "src/schemas/inspection.ts", "src/schemas/mutations.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.equal(/passthrough/.test(source), false, `${file} must not use passthrough`);
  }
});

test("tools/list over stdio negotiates 2026-07-28 and returns schemas", async () => {
  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= TOOL_DEFINITIONS.length - 2, `expected full registry, got ${tools.length}`);
    assert.deepEqual(tools.map(tool => tool.name), TOOL_DEFINITIONS.map(tool => tool.name));
    const status = tools.find(tool => tool.name === "get_server_readiness");
    assert.ok(status);
    assert.ok(status.annotations, "tools/list must include annotations");
    assert.ok(status.inputSchema, "tools/list must include input schemas");
    assert.equal(status.outputSchema?.properties?.ok?.description, "True when the tool completed successfully; false when the result contains an error.");
    const machineProfile = tools.find(tool => tool.name === "validate_machine_profile");
    assert.equal(
      machineProfile?.inputSchema.properties?.profile?.properties?.linearTravels?.properties?.x?.description,
      "Maximum verified linear travel along X from the machine home reference."
    );
  });
});

test("tools/list exposes only tools permitted by the active profile and hard-read-only setting", async () => {
  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.has("preview_operation_parameters"), true);
    assert.equal(names.has("apply_operation_parameter_preview"), false);
    assert.equal(names.has("rollback_change"), false);
    assert.equal(names.has("run_simulation"), false);
    assert.equal(names.has("detect_collisions"), false);
  }, { MASTERCAM_MCP_PROFILE: "read", MASTERCAM_MCP_HARD_READ_ONLY: "1" });

  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.has("apply_operation_parameter_preview"), true);
    assert.equal(names.has("rollback_change"), true);
    assert.equal(names.has("run_simulation"), false);
  }, { MASTERCAM_MCP_PROFILE: "write", MASTERCAM_MCP_HARD_READ_ONLY: "0" });

  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.has("apply_operation_parameter_preview"), true);
    assert.equal(names.has("run_simulation"), true);
    assert.equal(names.has("detect_collisions"), true);
  }, { MASTERCAM_MCP_PROFILE: "all", MASTERCAM_MCP_HARD_READ_ONLY: "0" });
});

test("capability discovery matches the active tools/list catalog", async () => {
  await withStdioClient(async client => {
    const listed = await client.listTools();
    const discovered = await client.callTool({ name: "discover_capabilities", arguments: {} });
    const data = discovered.structuredContent?.data as { tools: Array<{ name: string; requiresApproval: boolean }> };
    assert.deepEqual(data.tools.map(tool => tool.name), listed.tools.map(tool => tool.name));
    assert.equal(data.tools.find(tool => tool.name === "apply_operation_parameter_preview")?.requiresApproval, true);
  });
});

test("every declared MCP protocol revision can list and call tools over stdio", async () => {
  for (const protocolVersion of SUPPORTED_PROTOCOL_REVISIONS) {
    await withStdioClient(async client => {
      const { tools } = await client.listTools();
      assert.ok(tools.some(tool => tool.name === "get_server_readiness"), `readiness tool missing at ${protocolVersion}`);
      const result = await client.callTool({ name: "get_server_readiness", arguments: {} });
      assert.equal((result.structuredContent as { ok?: boolean } | undefined)?.ok, true, protocolVersion);
    }, {}, false, protocolVersion);
  }
});

test("compact tools/list is focused and replaces overlapping setup and context calls", async () => {
  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.equal(names.length, 24);
    assert.ok(names.includes("get_server_readiness"));
    assert.ok(names.includes("get_job_context"));
    for (const removed of ["get_machine_groups", "inspect", "measure", "assert", "mastercam_help", "list_tool_categories"]) {
      assert.equal(names.includes(removed), false, `${removed} must not be advertised`);
    }
  }, { MASTERCAM_MCP_TOOLSET: "compact" });
});

test("composite readiness and job context return source-tagged section results", async () => {
  await withStdioClient(async client => {
    const status = await client.callTool({ name: "get_server_readiness", arguments: {} });
    assert.equal((status.structuredContent as { ok: boolean }).ok, true);
    const context = await client.callTool({ name: "get_job_context", arguments: { sections: ["part", "stock"] } });
    const data = (context.structuredContent as { data: { sections: Record<string, { status: string }> } }).data;
    assert.equal(data.sections.part?.status, "available");
    assert.equal(data.sections.stock?.status, "available");
  }, { MASTERCAM_MCP_TOOLSET: "compact" });
});

test("audit history reports disabled collection explicitly over MCP", async () => {
  await withStdioClient(async client => {
    const result = await client.callTool({ name: "get_audit_history", arguments: {} });
    assert.equal((result.structuredContent as { ok: boolean }).ok, true);
    const data = (result.structuredContent as { data: { enabled: boolean; integrity: string; entries: unknown[] } }).data;
    assert.equal(data.enabled, false);
    assert.equal(data.integrity, "disabled");
    assert.deepEqual(data.entries, []);
  }, { MASTERCAM_MCP_TOOLSET: "compact", MASTERCAM_MCP_AUDIT: "0" });
});

test("one cycle-time tool supports active operations and supplied motion evidence", async () => {
  await withStdioClient(async client => {
    const active = await client.callTool({
      name: "analyze_cycle_time", arguments: { source: "active_operations", operationIds: [1] }
    });
    assert.equal((active.structuredContent?.data as { seconds: number }).seconds, 42);
    const events = await client.callTool({
      name: "analyze_cycle_time",
      arguments: {
        source: "motion_events",
        machineRapidRate: 100,
        events: [{ id: "move-1", kind: "move", motion: "rapid", start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 10 } }]
      }
    });
    assert.equal(events.structuredContent?.ok, true);
  });
});

test("tool catalog unit mismatches return actionable validation errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mastercam-mcp-unit-error-"));
  const catalogPath = join(directory, "tools.json");
  writeFileSync(catalogPath, JSON.stringify({
    schema: "mastercam-mcp/tool-library/v1",
    units: "mm",
    tools: [{ number: 1, name: "OD turning insert", type: "turning insert" }]
  }));
  try {
    await withStdioClient(async client => {
      const result = await client.callTool({
        name: "plan_od_rough_finish",
        arguments: {
          intent: "Rough and finish the supplied OD profile",
          units: "inch",
          material: "6061 aluminum",
          stockDiameter: 2,
          profile: [{ z: 0, diameter: 1.8 }, { z: 1, diameter: 1.2 }],
          finishAllowanceRadial: 0.01
        }
      });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent?.error as { code?: string }).code, "VALIDATION_FAILED");
    }, { MASTERCAM_MCP_TOOL_LIBRARY: catalogPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown tool call fails with a typed MCP error (BUG-02 contract)", async () => {
  const backend = new (await import("../src/backend.js")).MockBackend();
  const result = await backend.call({ id: "u1", tool: "definitely_not_a_tool", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNSUPPORTED_TOOL");

  await withStdioClient(async client => {
    await assert.rejects(
      () => client.callTool({ name: "definitely_not_a_tool", arguments: {} }),
      /not found|unknown|tool/i
    );
  });
});

test("a selected stdio catalog limits discovery and rejects omitted tools", async () => {
  const selected = ["get_server_readiness", "get_job_context", "analyze_nc_program"];
  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), selected);
    const result = await client.callTool({ name: "get_server_readiness", arguments: {} });
    assert.equal(result.structuredContent?.ok, true);

    await assert.rejects(
      () => client.callTool({ name: "list_operations", arguments: {} }),
      /not found|unknown|tool/i
    );
    await assert.rejects(
      () => client.callTool({ name: "mastercam_help", arguments: {} }),
      /not found|unknown|tool/i
    );
  }, { MASTERCAM_MCP_TOOLS: selected.join(",") });
});

test("a hard-read-only server does not advertise an allowlisted mutation", async () => {
  await withStdioClient(async client => {
    const { tools } = await client.listTools();
    assert.equal(tools.some(tool => tool.name === "apply_operation_parameter_preview"), false);
    await assert.rejects(
      () => client.callTool({ name: "apply_operation_parameter_preview", arguments: { approvalToken: "not-an-approval" } }),
      /not found|unknown|tool/i
    );
  }, { MASTERCAM_MCP_TOOLS: "apply_operation_parameter_preview,get_server_readiness", MASTERCAM_MCP_HARD_READ_ONLY: "1" });
});

test("tool call returns structuredContent plus text content (ARCH-02)", async () => {
  await withStdioClient(async client => {
    const result = await client.callTool({ name: "get_server_readiness", arguments: {} });
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    assert.equal((result.structuredContent as { ok?: boolean } | undefined)?.ok, true);
    const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    const parsed = JSON.parse(text) as { ok?: boolean };
    assert.equal(parsed.ok, true);
  });
});

test("preview requires quantity units; bare numbers are rejected (SAFE-01)", async () => {
  await withStdioClient(async client => {
    const missingUnit = await client.callTool({
      name: "preview_operation_parameters",
      arguments: { operationId: 4, changes: { feedRate: { value: 100 } } }
    });
    assert.equal(missingUnit.isError, true);
    const missingUnitText =
      missingUnit.content[0] && "text" in missingUnit.content[0] ? missingUnit.content[0].text : "";
    assert.match(missingUnitText, /unit|invalid/i);

    const emptyChanges = await client.callTool({
      name: "preview_operation_parameters",
      arguments: { operationId: 4, changes: {} }
    });
    assert.equal(emptyChanges.isError, true);
    const emptyText =
      emptyChanges.content[0] && "text" in emptyChanges.content[0] ? emptyChanges.content[0].text : "";
    assert.match(emptyText, /feedRate|spindleSpeed|invalid/i);
  });
});

test("a preview token alone cannot apply a change without the MCP client approval round trip", async () => {
  await withStdioClient(async client => {
    const before = await client.callTool({ name: "list_operations", arguments: {} });
    const initial = (before.structuredContent as { data?: Array<Record<string, unknown>> }).data ?? [];
    const operation = initial.find(item => item.id === 4);
    assert.ok(operation);
    const originalFeed = operation.feedRate;
    const previewResult = await client.callTool({
      name: "preview_operation_parameters",
      arguments: { operationId: 4, changes: { feedRate: { value: 1234, unit: "mm/min" } } }
    });
    const token = (previewResult.structuredContent as { data?: { approvalToken?: string } }).data?.approvalToken;
    assert.ok(token);

    await assert.rejects(
      () => client.callTool({ name: "apply_operation_parameter_preview", arguments: { approvalToken: token } }),
      /elicitation|input|required|capability/i
    );
    const after = await client.callTool({ name: "list_operations", arguments: {} });
    const current = ((after.structuredContent as { data?: Array<Record<string, unknown>> }).data ?? []).find(item => item.id === 4);
    assert.deepEqual(current?.feedRate, originalFeed);
  });
});

test("the MCP operator approval round trip applies the exact signed preview", async () => {
  await withStdioClient(async client => {
    const preview = await client.callTool({
      name: "preview_operation_parameters",
      arguments: { operationId: 4, changes: { feedRate: { value: 1234, unit: "mm/min" } } }
    });
    const token = (preview.structuredContent as { data?: { approvalToken?: string } }).data?.approvalToken;
    assert.ok(token);
    const applied = await client.callTool({ name: "apply_operation_parameter_preview", arguments: { approvalToken: token } });
    assert.notEqual(applied.isError, true);
    assert.equal((applied.structuredContent as { data?: { applied?: boolean } }).data?.applied, true);
  }, {}, true);
});

test("capability registry never claims live verification (P0-01 contract)", async () => {
  const { capabilityReport } = await import("../src/capabilities.js");
  const report = capabilityReport("mock");
  const liveTiers: readonly string[] = ["LIVE_READ_VERIFIED", "LIVE_WRITE_VERIFIED"];
  for (const capability of report.capabilities) {
    assert.ok(
      !liveTiers.includes(capability.tier),
      `${capability.name} must not claim live verification without licensed testing`
    );
  }
  assert.equal(report.live, false);
});

test("generated CAPABILITIES.md matches the registry", async () => {
  const { renderCapabilitiesDoc } = await import("../src/capabilities.js");
  const { readFile } = await import("node:fs/promises");
  const checkedIn = (
    await readFile(new URL("../docs/CAPABILITIES.md", import.meta.url), "utf8")
  ).replaceAll("\r\n", "\n");
  assert.equal(
    checkedIn,
    renderCapabilitiesDoc(),
    "docs/CAPABILITIES.md is stale; run pnpm run docs:capabilities"
  );
});
