#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VERSION } from "./version.js";
import { doctor } from "./diagnostics.js";
import { defaultPipe, platformGuidance } from "./platform.js";
import { MockBackend } from "./backend.js";
import { LiveBackend } from "./live-backend.js";
import { loadConfig } from "./config.js";
import { runAcceptance, saveAcceptanceReport } from "./acceptance/harness.js";

const command = process.argv[2] ?? "serve";

if (command === "version" || command === "--version" || command === "-v") {
  console.log(`mastercam-mcp ${VERSION}`);
} else if (command === "serve") {
  await import("./server.js");
} else if (command === "doctor") {
  const config = loadConfig();
  const mode = config.backend === "mock"
    ? "mock"
    : config.backend === "live" || config.backend === "pipe"
      ? "pipe"
      : process.platform === "win32" ? "pipe" : "mock";
  const result = await doctor(config.pipe ?? defaultPipe(), mode);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} else if (command === "benchmark") {
  console.log(JSON.stringify(await benchmarkMock(), null, 2));
} else if (command === "acceptance") {
  await runAcceptanceCommand(process.argv.slice(3));
} else if (command === "install") {
  if (process.platform !== "win32") throw new Error("The Mastercam add in installer requires Windows");
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "install.ps1");
  if (!existsSync(script)) throw new Error(`Installer script was not included in this package: ${script}`);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...process.argv.slice(3)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
} else {
  console.error(
    "Usage: mastercam-mcp [serve|doctor|benchmark|acceptance|install]\n" +
    "Acceptance: mastercam-mcp acceptance --mock | --live [--allow-writes]\n" +
    platformGuidance()
  );
  process.exit(2);
}

async function runAcceptanceCommand(args: string[]): Promise<void> {
  const wantsLive = args.includes("--live");
  const wantsMock = args.includes("--mock");
  const allowWrites = args.includes("--allow-writes");
  if (wantsLive && wantsMock) throw new Error("Choose exactly one of --live or --mock");
  if (allowWrites && !wantsLive) throw new Error("--allow-writes is only valid with --live");

  const mode: "mock" | "live" = wantsLive ? "live" : "mock";
  if (mode === "live" && process.platform !== "win32") {
    throw new Error("Live acceptance requires Windows with a running Mastercam add-in");
  }

  const config = loadConfig();
  const backend = mode === "live"
    ? new LiveBackend({
        endpoint: config.pipe,
        connectTimeoutMs: config.transport.connectTimeoutMs,
        idleTimeoutMs: config.transport.idleTimeoutMs,
        maxResponseBytes: config.transport.maxResponseBytes,
        circuitBreaker: config.transport.circuitBreaker
      })
    : new MockBackend();

  try {
    const report = await runAcceptance(backend, {
      mode,
      allowWrites,
      ...(mode === "mock" ? { mastercamRelease: "fixture", adapterVersion: VERSION } : {})
    });
    const path = await saveAcceptanceReport(report);
    console.log(JSON.stringify(report, null, 2));
    console.error(`Acceptance report saved to: ${path}`);
    if (report.overall === "FAIL") process.exitCode = 1;
  } finally {
    if (backend instanceof LiveBackend) await backend.close();
  }
}

async function benchmarkMock() {
  const backend = new MockBackend({ feed: 35 });
  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index] ?? 0;
  };
  const run = async (tool: string, count: number, args: Record<string, unknown> = {}) => {
    const samples: number[] = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await backend.call({ id: `bench-${i}`, tool, arguments: args });
      samples.push(performance.now() - start);
    }
    return {
      calls: count,
      medianMs: Number(percentile(samples, 50).toFixed(3)),
      p95Ms: Number(percentile(samples, 95).toFixed(3)),
      p99Ms: Number(percentile(samples, 99).toFixed(3))
    };
  };
  return {
    generatedAt: new Date().toISOString(),
    backend: "mock",
    note: "Fixture benchmark; live bridge overhead must be measured separately against a running Mastercam",
    status: await run("mastercam_status", 1000),
    operationLookup: await run("get_operation", 500, { operationId: 4 }),
    operationList: await run("list_operations", 100),
    contextBundle: await run("get_programming_context", 100)
  };
}
