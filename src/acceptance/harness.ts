import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Backend, ToolResult } from "../backend.js";

export interface AcceptanceTestResult {
  test: string;
  status: "PASS" | "FAIL" | "NOT_SUPPORTED" | "SKIPPED";
  message?: string;
  durationMs?: number;
  evidence?: unknown;
}

export interface AcceptanceReadiness {
  stageBContextReady: boolean;
  liveReadReady: boolean;
  liveWriteReady: boolean;
  liveReadBlockers: string[];
  liveWriteBlockers: string[];
  conclusion:
    | "FIXTURE_ONLY"
    | "LIVE_NOT_READY"
    | "READ_READY_WRITE_NOT_EVALUATED"
    | "READ_READY_WRITE_BLOCKED"
    | "READ_WRITE_READY";
}

export interface AcceptanceReport {
  mode: "mock" | "live";
  writeTestsEnabled: boolean;
  mastercamRelease: string;
  adapterVersion: string;
  protocolVersion: number;
  timestamp: string;
  tests: Record<string, AcceptanceTestResult>;
  overall: "PASS" | "FAIL" | "PARTIAL";
  readiness: AcceptanceReadiness;
}

export interface AcceptanceOptions {
  mode: "mock" | "live";
  allowWrites?: boolean;
  mastercamRelease?: string;
  adapterVersion?: string;
}

type AcceptanceTestName =
  | "status" | "programmingContext" | "activePart" | "operations" | "tools" | "stock" | "wcs"
  | "preview" | "apply" | "verify" | "rollback" | "simulation" | "collisions";

interface Quantity { value: number; unit: string }

interface TestContext {
  backend: Backend;
  results: Record<string, AcceptanceTestResult>;
  allowWrites: boolean;
  statusInfo?: Record<string, unknown>;
  operationIds?: number[];
  currentFeed?: Quantity;
  changedFeed?: Quantity;
  appliedTransactionId?: string;
}

class NotSupportedError extends Error {}

function unsupported(result: ToolResult): boolean {
  const code = result.error?.code ?? "";
  return ["UNSUPPORTED_TOOL", "UNSUPPORTED_CAPABILITY", "CAPABILITY_UNAVAILABLE"].includes(code);
}

function requireOk(result: ToolResult, tool: string): ToolResult {
  if (result.ok) return result;
  if (unsupported(result)) throw new NotSupportedError(`${tool}: ${result.error?.message ?? "not supported"}`);
  throw new Error(`${tool} failed: ${result.error?.message ?? result.error?.code ?? "unknown error"}`);
}

async function runTest(
  name: AcceptanceTestName,
  fn: (ctx: TestContext) => Promise<unknown>,
  ctx: TestContext,
  skipReason?: string
): Promise<void> {
  if (skipReason) {
    ctx.results[name] = { test: name, status: "SKIPPED", message: skipReason };
    return;
  }
  const start = Date.now();
  try {
    const evidence = await fn(ctx);
    ctx.results[name] = {
      test: name,
      status: "PASS",
      durationMs: Date.now() - start,
      ...(evidence === undefined ? {} : { evidence })
    };
  } catch (error) {
    if (error instanceof NotSupportedError) {
      ctx.results[name] = {
        test: name,
        status: "NOT_SUPPORTED",
        message: error.message,
        durationMs: Date.now() - start
      };
      return;
    }
    ctx.results[name] = {
      test: name,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start
    };
  }
}

async function testStatus(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a1", tool: "mastercam_status", arguments: {} }), "mastercam_status");
  if (!result.data || typeof result.data !== "object") throw new Error("mastercam_status missing data");
  ctx.statusInfo = result.data as Record<string, unknown>;
  return result.data;
}

async function testProgrammingContext(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({
    id: "a1b",
    tool: "get_programming_context",
    arguments: { includeGeometry: false }
  }), "get_programming_context");
  if (!result.data || typeof result.data !== "object") throw new Error("get_programming_context missing data");
  const data = result.data as {
    operations?: unknown[];
    coverage?: { operationsEnumerated?: boolean; stableOperationIds?: boolean };
    documentRevision?: string;
  };
  if (!Array.isArray(data.operations)) throw new Error("get_programming_context missing operations array");
  if (data.coverage && data.coverage.operationsEnumerated === false) {
    throw new Error("programming context did not enumerate operations");
  }
  return {
    operationCount: data.operations.length,
    stableOperationIds: data.coverage?.stableOperationIds,
    documentRevision: data.documentRevision
  };
}

async function testActivePart(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a2", tool: "get_active_part", arguments: {} }), "get_active_part");
  const data = result.data as { name?: string };
  if (!data?.name) throw new Error("get_active_part missing part name");
  return data;
}

async function testOperations(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a3", tool: "list_operations", arguments: {} }), "list_operations");
  const ops = result.data as Array<{ id: number; feedRate?: Quantity; feed?: Quantity }>;
  if (!Array.isArray(ops) || !ops.length) throw new Error("list_operations returned empty list");
  ctx.operationIds = ops.map(op => op.id);
  const firstFeed = ops[0]?.feedRate ?? ops[0]?.feed;
  if (firstFeed && Number.isFinite(firstFeed.value) && firstFeed.value > 0 && typeof firstFeed.unit === "string") {
    ctx.currentFeed = { value: firstFeed.value, unit: firstFeed.unit };
    ctx.changedFeed = { value: Number((firstFeed.value * 1.01).toPrecision(12)), unit: firstFeed.unit };
  }
  return { count: ops.length, firstOperationId: ctx.operationIds[0] };
}

async function testTools(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a4", tool: "list_tools", arguments: {} }), "list_tools");
  const tools = result.data as unknown[];
  if (!Array.isArray(tools) || !tools.length) throw new Error("list_tools returned empty list");
  return { count: tools.length };
}

async function testStock(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a5", tool: "get_stock", arguments: {} }), "get_stock");
  if (!result.data || typeof result.data !== "object") throw new Error("get_stock missing data");
  return result.data;
}

async function testWcs(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a6", tool: "get_wcs", arguments: {} }), "get_wcs");
  if (!result.data || typeof result.data !== "object") throw new Error("get_wcs missing data");
  return result.data;
}

async function testPreview(ctx: TestContext): Promise<unknown> {
  if (!ctx.operationIds?.length) throw new NotSupportedError("No operation is available for preview");
  if (!ctx.changedFeed) throw new NotSupportedError("First operation has no feed quantity suitable for preview");
  const result = requireOk(await ctx.backend.call({
    id: "a7",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: ctx.operationIds[0],
      changes: { feedRate: ctx.changedFeed }
    }
  }), "preview_operation_parameters");
  const data = result.data as { approvalToken?: string };
  if (!data?.approvalToken) throw new Error("preview missing approvalToken");
  return { operationId: ctx.operationIds[0], proposedFeed: ctx.changedFeed };
}

async function testApply(ctx: TestContext): Promise<unknown> {
  if (!ctx.operationIds?.length || !ctx.changedFeed) throw new NotSupportedError("No writable operation/feed is available");
  const preview = requireOk(await ctx.backend.call({
    id: "a8a",
    tool: "preview_operation_parameters",
    arguments: {
      operationId: ctx.operationIds[0],
      changes: { feedRate: ctx.changedFeed }
    }
  }), "preview_operation_parameters");
  const token = (preview.data as { approvalToken?: string })?.approvalToken;
  if (!token) throw new Error("preview for apply missing approvalToken");

  const apply = requireOk(await ctx.backend.call({
    id: "a8b",
    tool: "apply_operation_parameter_preview",
    arguments: { approvalToken: token }
  }), "apply_operation_parameter_preview");

  const data = apply.data as { rollback?: { transactionId?: string } };
  const transactionId = data?.rollback?.transactionId;
  if (!transactionId) throw new Error("apply did not return rollback transactionId");
  ctx.appliedTransactionId = transactionId;
  return { operationId: ctx.operationIds[0], transactionId };
}

async function testVerify(ctx: TestContext): Promise<unknown> {
  if (!ctx.operationIds?.length || !ctx.changedFeed || !ctx.appliedTransactionId) {
    throw new NotSupportedError("No successful acceptance write is available to verify");
  }
  const verify = requireOk(await ctx.backend.call({
    id: "a9",
    tool: "verify_change",
    arguments: {
      operationId: ctx.operationIds[0],
      expected: { feedRate: ctx.changedFeed }
    }
  }), "verify_change");
  const data = verify.data as { pass?: boolean };
  if (!data?.pass) throw new Error("verify_change reported mismatch");
  return data;
}

async function testRollback(ctx: TestContext): Promise<unknown> {
  if (!ctx.appliedTransactionId) throw new NotSupportedError("No acceptance transaction is available to roll back");
  const rollback = requireOk(await ctx.backend.call({
    id: "a10",
    tool: "rollback_change",
    arguments: { transactionId: ctx.appliedTransactionId }
  }), "rollback_change");

  if (ctx.operationIds?.length && ctx.currentFeed) {
    const verify = requireOk(await ctx.backend.call({
      id: "a10v",
      tool: "verify_change",
      arguments: {
        operationId: ctx.operationIds[0],
        expected: { feedRate: ctx.currentFeed }
      }
    }), "verify_change after rollback");
    const data = verify.data as { pass?: boolean };
    if (!data?.pass) throw new Error("rollback verification did not restore the original feed");
  }
  return rollback.data;
}

async function testSimulation(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a11", tool: "run_simulation", arguments: {} }), "run_simulation");
  return result.data;
}

async function testCollisions(ctx: TestContext): Promise<unknown> {
  const result = requireOk(await ctx.backend.call({ id: "a12", tool: "detect_collisions", arguments: {} }), "detect_collisions");
  return result.data;
}

export async function runAcceptance(backend: Backend, options: AcceptanceOptions): Promise<AcceptanceReport> {
  const ctx: TestContext = {
    backend,
    results: {},
    allowWrites: options.allowWrites === true
  };

  await runTest("status", testStatus, ctx);
  if (options.mode === "live") {
    await runTest("programmingContext", testProgrammingContext, ctx);
  }
  await runTest("activePart", testActivePart, ctx);
  await runTest("operations", testOperations, ctx);
  await runTest("tools", testTools, ctx);
  await runTest("stock", testStock, ctx);
  await runTest("wcs", testWcs, ctx);
  await runTest("preview", testPreview, ctx);

  const writeSkip = ctx.allowWrites
    ? undefined
    : "Write acceptance disabled. Re-run a disposable test part with --live --allow-writes.";
  await runTest("apply", testApply, ctx, writeSkip);
  await runTest("verify", testVerify, ctx, writeSkip);
  await runTest("rollback", testRollback, ctx, writeSkip);

  await runTest("simulation", testSimulation, ctx);
  await runTest("collisions", testCollisions, ctx);

  const statuses = Object.values(ctx.results).map(result => result.status);
  const overall: AcceptanceReport["overall"] = statuses.includes("FAIL")
    ? "FAIL"
    : statuses.some(status => status === "NOT_SUPPORTED" || status === "SKIPPED")
      ? "PARTIAL"
      : "PASS";

  const status = ctx.statusInfo ?? {};
  const readRequirements: AcceptanceTestName[] = ["status", "activePart", "operations", "tools", "stock", "wcs"];
  const writeRequirements: AcceptanceTestName[] = ["preview", "apply", "verify", "rollback"];
  const failedRequirements = (names: AcceptanceTestName[]) =>
    names.filter(name => ctx.results[name]?.status !== "PASS");

  const liveReadBlockers = options.mode === "live"
    ? failedRequirements(readRequirements)
    : ["fixture mode does not establish live Mastercam readiness"];
  const liveWriteBlockers = options.mode === "live" && ctx.allowWrites
    ? failedRequirements(writeRequirements)
    : options.mode === "live"
      ? ["write readiness not evaluated; rerun on a disposable part with --allow-writes"]
      : ["fixture mode does not establish live Mastercam write readiness"];
  const stageBContextReady =
    options.mode === "live" && ctx.results.programmingContext?.status === "PASS";
  const liveReadReady = options.mode === "live" && liveReadBlockers.length === 0;
  const liveWriteReady = options.mode === "live" && ctx.allowWrites && liveWriteBlockers.length === 0;
  const conclusion: AcceptanceReadiness["conclusion"] =
    options.mode !== "live"
      ? "FIXTURE_ONLY"
      : !liveReadReady
        ? "LIVE_NOT_READY"
        : !ctx.allowWrites
          ? "READ_READY_WRITE_NOT_EVALUATED"
          : liveWriteReady
            ? "READ_WRITE_READY"
            : "READ_READY_WRITE_BLOCKED";

  return {
    mode: options.mode,
    writeTestsEnabled: ctx.allowWrites,
    mastercamRelease: String(options.mastercamRelease ?? status.mastercamVersion ?? "unknown"),
    adapterVersion: String(options.adapterVersion ?? status.adapter ?? status.adapterVersion ?? "unknown"),
    protocolVersion: Number(status.protocolVersion ?? 2),
    timestamp: new Date().toISOString(),
    tests: ctx.results,
    overall,
    readiness: {
      stageBContextReady,
      liveReadReady,
      liveWriteReady,
      liveReadBlockers,
      liveWriteBlockers,
      conclusion
    }
  };
}

export async function saveAcceptanceReport(report: AcceptanceReport, outputDir?: string): Promise<string> {
  const dir = outputDir ?? join(homedir(), ".mastercam-mcp", "acceptance");
  await mkdir(dir, { recursive: true });
  const filename = `acceptance-${report.mode}-${report.mastercamRelease}-${report.adapterVersion}-${Date.now()}.json`;
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

export async function loadAcceptanceReport(path: string): Promise<AcceptanceReport> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as AcceptanceReport;
}
