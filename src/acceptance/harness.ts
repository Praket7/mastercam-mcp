import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MockBackend } from "../backend.js";

export interface AcceptanceTestResult {
  test: string;
  status: "PASS" | "FAIL" | "NOT_SUPPORTED" | "SKIPPED";
  message?: string;
  durationMs?: number;
  evidence?: unknown;
}

export interface AcceptanceReport {
  mastercamRelease: string;
  adapterVersion: string;
  protocolVersion: number;
  timestamp: string;
  tests: Record<string, AcceptanceTestResult>;
  overall: "PASS" | "FAIL" | "PARTIAL";
}

type AcceptanceTestName = "status" | "activePart" | "operations" | "tools" | "stock" | "wcs" | "preview" | "apply" | "verify" | "rollback" | "simulation" | "collisions";

interface TestContext {
  backend: MockBackend;
  results: Record<string, AcceptanceTestResult>;
  partName?: string;
  operationIds?: number[];
  toolNumbers?: number[];
}

async function runTest(name: AcceptanceTestName, fn: (ctx: TestContext) => Promise<void>, ctx: TestContext): Promise<void> {
  const start = Date.now();
  try {
    await fn(ctx);
    ctx.results[name] = { test: name, status: "PASS", durationMs: Date.now() - start };
  } catch (error) {
    ctx.results[name] = {
      test: name,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start
    };
  }
}

async function testStatus(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a1", tool: "mastercam_status", arguments: {} });
  if (!result.ok) throw new Error(`mastercam_status failed: ${result.error?.message}`);
  if (!result.data || typeof result.data !== "object") throw new Error("mastercam_status missing data");
}

async function testActivePart(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a2", tool: "get_active_part", arguments: {} });
  if (!result.ok) throw new Error(`get_active_part failed: ${result.error?.message}`);
  const data = result.data as { name?: string };
  if (!data.name) throw new Error("get_active_part missing part name");
  ctx.partName = data.name;
}

async function testOperations(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a3", tool: "list_operations", arguments: {} });
  if (!result.ok) throw new Error(`list_operations failed: ${result.error?.message}`);
  const ops = result.data as Array<{ id: number }>;
  if (!ops.length) throw new Error("list_operations returned empty list");
  ctx.operationIds = ops.map(o => o.id);
}

async function testTools(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a4", tool: "list_tools", arguments: {} });
  if (!result.ok) throw new Error(`list_tools failed: ${result.error?.message}`);
  const tools = result.data as Array<{ number: number }>;
  if (!tools.length) throw new Error("list_tools returned empty list");
  ctx.toolNumbers = tools.map(t => t.number);
}

async function testStock(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a5", tool: "get_stock", arguments: {} });
  if (!result.ok) throw new Error(`get_stock failed: ${result.error?.message}`);
  const data = result.data as { dimensions?: { x: number; y: number; z: number } };
  if (!data.dimensions) throw new Error("get_stock missing dimensions");
}

async function testWcs(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a6", tool: "get_wcs", arguments: {} });
  if (!result.ok) throw new Error(`get_wcs failed: ${result.error?.message}`);
  const data = result.data as { name?: string; origin?: number[] };
  if (!data.name) throw new Error("get_wcs missing name");
}

async function testPreview(ctx: TestContext): Promise<void> {
  if (!ctx.operationIds?.length) throw new Error("No operations available for preview test");
  const result = await ctx.backend.call({
    id: "a7",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: ctx.operationIds[0],
      changes: { feedRate: { value: 100, unit: "mm/min" } }
    }
  });
  if (!result.ok) throw new Error(`preview_operation_parameters failed: ${result.error?.message}`);
  const data = result.data as { approvalToken?: string };
  if (!data.approvalToken) throw new Error("preview missing approvalToken");
}

async function testApply(ctx: TestContext): Promise<void> {
  if (!ctx.operationIds?.length) throw new Error("No operations available for apply test");
  const preview = await ctx.backend.call({
    id: "a8a",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: ctx.operationIds[0],
      changes: { feedRate: { value: 200, unit: "mm/min" } }
    }
  });
  if (!preview.ok) throw new Error(`preview for apply failed: ${preview.error?.message}`);
  const token = (preview.data as { approvalToken: string }).approvalToken;

  const apply = await ctx.backend.call({
    id: "a8b",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken: token }
  });
  if (!apply.ok) throw new Error(`apply_operation_parameter_preview failed: ${apply.error?.message}`);
}

async function testVerify(ctx: TestContext): Promise<void> {
  if (!ctx.operationIds?.length) throw new Error("No operations available for verify test");
  const verify = await ctx.backend.call({
    id: "a9",
    tool: "verify_change",
    arguments: {
      operationId: ctx.operationIds[0],
      expected: { feedRate: { value: 200, unit: "mm/min" } }
    }
  });
  if (!verify.ok) throw new Error(`verify_change failed: ${verify.error?.message}`);
  const data = verify.data as { pass?: boolean };
  if (!data.pass) throw new Error("verify_change reported mismatch");
}

async function testRollback(ctx: TestContext): Promise<void> {
  if (!ctx.operationIds?.length) throw new Error("No operations available for rollback test");
  const preview = await ctx.backend.call({
    id: "a10a",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: ctx.operationIds[0],
      changes: { feedRate: { value: 300, unit: "mm/min" } }
    }
  });
  if (!preview.ok) throw new Error(`preview for rollback failed: ${preview.error?.message}`);
  const token = (preview.data as { approvalToken: string }).approvalToken;

  const apply = await ctx.backend.call({
    id: "a10b",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken: token }
  });
  if (!apply.ok) throw new Error(`apply for rollback failed: ${apply.error?.message}`);
  const rollbackToken = (apply.data as { rollback: { transactionId: string } }).rollback.transactionId;

  const rollback = await ctx.backend.call({
    id: "a10c",
    tool: "rollback_change",
    arguments: { transactionId: rollbackToken }
  });
  if (!rollback.ok) throw new Error(`rollback_change failed: ${rollback.error?.message}`);
}

async function testSimulation(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a11", tool: "run_simulation", arguments: {} });
  if (!result.ok) {
    if (result.error?.code === "UNSUPPORTED_TOOL") {
      ctx.results.simulation = { test: "simulation", status: "NOT_SUPPORTED", message: "Simulation not supported by backend" };
      return;
    }
    throw new Error(`run_simulation failed: ${result.error?.message}`);
  }
  ctx.results.simulation = { test: "simulation", status: "PASS", durationMs: 0 };
}

async function testCollisions(ctx: TestContext): Promise<void> {
  const result = await ctx.backend.call({ id: "a12", tool: "detect_collisions", arguments: {} });
  if (!result.ok) {
    if (result.error?.code === "UNSUPPORTED_TOOL") {
      ctx.results.collisions = { test: "collisions", status: "NOT_SUPPORTED", message: "Collision detection not supported by backend" };
      return;
    }
    throw new Error(`detect_collisions failed: ${result.error?.message}`);
  }
  ctx.results.collisions = { test: "collisions", status: "PASS", durationMs: 0 };
}

export async function runAcceptance(backend: MockBackend, mastercamRelease: string, adapterVersion: string): Promise<AcceptanceReport> {
  const ctx: TestContext = { backend, results: {} };

  await runTest("status", testStatus, ctx);
  await runTest("activePart", testActivePart, ctx);
  await runTest("operations", testOperations, ctx);
  await runTest("tools", testTools, ctx);
  await runTest("stock", testStock, ctx);
  await runTest("wcs", testWcs, ctx);
  await runTest("preview", testPreview, ctx);
  await runTest("apply", testApply, ctx);
  await runTest("verify", testVerify, ctx);
  await runTest("rollback", testRollback, ctx);
  await runTest("simulation", testSimulation, ctx);
  await runTest("collisions", testCollisions, ctx);

  const failed = Object.values(ctx.results).filter(r => r.status === "FAIL").length;
  const overall: AcceptanceReport["overall"] = failed === 0 ? "PASS" : failed < Object.keys(ctx.results).length ? "PARTIAL" : "FAIL";

  const report: AcceptanceReport = {
    mastercamRelease,
    adapterVersion,
    protocolVersion: 2,
    timestamp: new Date().toISOString(),
    tests: ctx.results,
    overall
  };

  return report;
}

export async function saveAcceptanceReport(report: AcceptanceReport, outputDir?: string): Promise<string> {
  const dir = outputDir ?? join(homedir(), ".mastercam-mcp", "acceptance");
  await mkdir(dir, { recursive: true });
  const filename = `acceptance-${report.mastercamRelease}-${report.adapterVersion}-${Date.now()}.json`;
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

export async function loadAcceptanceReport(path: string): Promise<AcceptanceReport> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as AcceptanceReport;
}