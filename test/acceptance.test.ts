import test from "node:test";
import assert from "node:assert/strict";
import { MockBackend } from "../src/backend.js";
import type { Backend, ToolResult } from "../src/backend.js";
import { runAcceptance } from "../src/acceptance/harness.js";
import { compatibilityReport } from "../src/compatibility.js";

test("fixture acceptance never claims live readiness", async () => {
  const report = await runAcceptance(new MockBackend(), {
    mode: "mock",
    mastercamRelease: "fixture",
    adapterVersion: "test"
  });
  assert.equal(report.readiness.liveReadReady, false);
  assert.equal(report.readiness.liveWriteReady, false);
  assert.equal(report.readiness.conclusion, "FIXTURE_ONLY");
});

test("Stage-A live adapter is blocked until required inspection mappings exist", async () => {
  const stageA: Backend = {
    async call(request): Promise<ToolResult> {
      if (request.tool === "mastercam_status") {
        return {
          ok: true,
          tool: request.tool,
          data: {
            connected: true,
            backend: "mastercam-net-hook",
            adapter: "stage-a-test",
            runtime: "net48",
            mastercamVersion: "2026",
            protocolVersion: 2
          }
        };
      }
      if (request.tool === "mastercam_capabilities") {
        return {
          ok: true,
          tool: request.tool,
          data: {
            adapterVersion: "stage-a-test",
            mastercamVersion: "2026",
            runtime: "net48",
            protocol: "bridge-v2",
            tools: [],
            note: "environment only"
          }
        };
      }
      return {
        ok: false,
        tool: request.tool,
        error: {
          code: "UNSUPPORTED_CAPABILITY",
          message: "not mapped",
          retryable: false
        }
      };
    }
  };

  const report = await runAcceptance(stageA, { mode: "live" });
  assert.equal(report.readiness.liveReadReady, false);
  assert.equal(report.readiness.conclusion, "LIVE_NOT_READY");
  assert.ok(report.readiness.liveReadBlockers.includes("activePart"));
  assert.ok(report.readiness.liveReadBlockers.includes("operations"));
});

test("compatibility report describes both native families as Stage A", () => {
  const report = compatibilityReport([]);
  const release2027 = report.matrix.find(entry => entry.release === "2027");
  assert.ok(release2027);
  assert.equal(release2027.status, "stage-a-environment-only");
  assert.equal(report.liveMappingsVerified, false);
  assert.ok(report.stageAAdaptersImplemented.includes("MastercamMcp.Addin.2027"));
});
