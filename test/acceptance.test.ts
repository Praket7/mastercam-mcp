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
  assert.equal(report.readiness.stageBContextReady, false);
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
  assert.equal(report.readiness.stageBContextReady, false);
  assert.equal(report.readiness.liveReadReady, false);
  assert.equal(report.readiness.conclusion, "LIVE_NOT_READY");
  assert.ok(report.readiness.liveReadBlockers.includes("activePart"));
  assert.ok(report.readiness.liveReadBlockers.includes("operations"));
});

test("Stage-B context can pass while full live-read readiness remains blocked", async () => {
  const stageB: Backend = {
    async call(request): Promise<ToolResult> {
      if (request.tool === "mastercam_status") {
        return {
          ok: true,
          tool: request.tool,
          data: {
            connected: true,
            backend: "mastercam-net-hook",
            adapter: "stage-b-test",
            runtime: "net10.0-windows",
            mastercamVersion: "2027",
            protocolVersion: 2,
            stageBReadsEnabled: true
          }
        };
      }
      if (request.tool === "get_programming_context") {
        return {
          ok: true,
          tool: request.tool,
          data: {
            operations: [{ id: 1, name: "OD Rough" }],
            tools: [{ number: 1, name: "CNMG" }],
            documentRevision: "rev-stage-b",
            coverage: { operationsEnumerated: true, stableOperationIds: true }
          }
        };
      }
      if (request.tool === "list_operations") {
        return {
          ok: true,
          tool: request.tool,
          data: [{ id: 1, feedRate: { value: 0.2, unit: "mm/rev" } }]
        };
      }
      if (request.tool === "list_tools") {
        return { ok: true, tool: request.tool, data: [{ number: 1, name: "CNMG" }] };
      }
      return {
        ok: false,
        tool: request.tool,
        error: { code: "UNSUPPORTED_CAPABILITY", message: "not mapped", retryable: false }
      };
    }
  };

  const report = await runAcceptance(stageB, { mode: "live" });
  assert.equal(report.readiness.stageBContextReady, true);
  assert.equal(report.readiness.liveReadReady, false);
  assert.ok(report.readiness.liveReadBlockers.includes("activePart"));
  assert.ok(report.readiness.liveReadBlockers.includes("stock"));
  assert.ok(report.readiness.liveReadBlockers.includes("wcs"));
});

test("compatibility report identifies 2027 as Stage-B read candidate", () => {
  const report = compatibilityReport([]);
  const release2027 = report.matrix.find(entry => entry.release === "2027");
  assert.ok(release2027);
  assert.equal(release2027.status, "stage-b-read-candidate");
  assert.equal(report.liveMappingsVerified, false);
  assert.ok(report.stageAAdaptersImplemented.includes("MastercamMcp.Addin.2027"));
  assert.ok(report.stageBReadCandidates.includes("MastercamMcp.Addin.2027"));
});
