#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VERSION } from "./version.js";
import { doctor } from "./diagnostics.js";
import { defaultPipe, platformGuidance, selectedBackend } from "./platform.js";
import { MockBackend } from "./backend.js";
import { runAcceptance, saveAcceptanceReport } from "./acceptance/harness.js";

const command = process.argv[2] ?? "serve";
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`mastercam-mcp ${VERSION}`);
  } else if (command === "serve") {
    await import("./server.js");
  } else if (command === "doctor") {
    const result = await doctor(process.env.MASTERCAM_MCP_PIPE ?? defaultPipe(), selectedBackend());
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "benchmark") {
    const result = await benchmarkMock();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "acceptance") {
    const backend = new MockBackend();
    const release = process.env.MASTERCAM_MCP_ACCEPTANCE_RELEASE ?? "fixture";
    const adapterVersion = VERSION;
    const report = await runAcceptance(backend, release, adapterVersion);
    const path = await saveAcceptanceReport(report);
    console.log(JSON.stringify(report, null, 2));
    console.error(`Acceptance report saved to: ${path}`);
    if (report.overall === "FAIL") process.exitCode = 1;
  } else if (command === "install") {
    if (process.platform !== "win32") throw new Error("The Mastercam add in installer requires Windows");
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "install.ps1");
    if (!existsSync(script)) throw new Error(`Installer script was not included in this package: ${script}`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...process.argv.slice(3)], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  } else {
    console.error(`Usage: mastercam-mcp [serve|doctor|benchmark|acceptance|install]\n${platformGuidance()}`);
    process.exit(2);
  }

/** Section 42/67: measure fixture latency so future transport work has a baseline. */
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
    return { calls: count, medianMs: Number(percentile(samples, 50).toFixed(3)), p95Ms: Number(percentile(samples, 95).toFixed(3)), p99Ms: Number(percentile(samples, 99).toFixed(3)) };
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
