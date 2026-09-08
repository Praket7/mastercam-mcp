import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Request, Response, ToolResult } from "./contracts.js";

export interface Backend { call(request: Request): Promise<ToolResult>; close?(): Promise<void> }

export class PipeBackend implements Backend {
  constructor(private readonly pipeName: string) {}
  call(request: Request): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipeName);
      let buffer = "";
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (error?: Error, result?: ToolResult) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result!); };
      timer = setTimeout(() => finish(new Error("Mastercam named pipe timeout")), 15000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", chunk => { buffer += chunk; if (buffer.length > 4 * 1024 * 1024) return finish(new Error("Mastercam named pipe response exceeded 4 MiB")); const line = buffer.split("\n")[0]; if (!line) return; try { const response = JSON.parse(line) as Response; if (response.id !== request.id) return finish(new Error("Mastercam named pipe response id mismatch")); finish(undefined, response.result); } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); } });
      socket.on("error", e => finish(e));
      socket.on("close", () => { if (!settled) finish(new Error("Mastercam named pipe closed before a response")); });
    });
  }
}

export class MockBackend implements Backend {
  private operations: Array<Record<string, unknown>>;
  private history: Array<Record<string, unknown>> = [];
  private selected: number[] = [4];
  private readonly auditPath: string;
  constructor(fixture?: { feed?: number; operations?: Array<Record<string, unknown>> }) {
    this.auditPath = process.env.MASTERCAM_MCP_AUDIT_PATH ?? join(process.env.LOCALAPPDATA ?? ".", "mastercam-mcp", "audit.json");
    try { if (existsSync(this.auditPath)) this.history = JSON.parse(readFileSync(this.auditPath, "utf8")); } catch { this.history = []; }
    const initialFeed = fixture?.feed !== undefined && Number.isFinite(fixture.feed) && fixture.feed > 0 ? fixture.feed : 35;
    this.operations = fixture?.operations?.length
      ? fixture.operations.map((operation, index) => ({ id: operation.id ?? index + 1, ...operation, feed: Number(operation.feed ?? initialFeed) }))
      : [{ id: 4, name: "Facing", type: "mill", feed: initialFeed }];
  }
  async call(request: Request): Promise<ToolResult> {
    const a = request.arguments ?? {};
    const operation = this.operation(a.operationId);
    const feed = Number(operation.feed);
    if (request.tool === "mastercam_status") return { ok: true, tool: request.tool, data: { connected: true, backend: "mock", version: "fixture" } };
    if (request.tool === "mastercam_capabilities") return { ok: true, tool: request.tool, data: { profile: "mock", live: false, fixture: true, supported: ["inspection", "targeting", "feedSpeed", "preview", "rollback", "regeneration", "simulation", "visualContext"] } };
    if (request.tool === "get_active_part") return this.result(request, { name: "fixture-part", path: "fixture://active-part", units: "mm", modified: false });
    if (request.tool === "get_geometry_summary") return this.result(request, { solids: 1, surfaces: 6, curves: 12, boundingBox: { x: 100, y: 80, z: 25 }, units: "mm" });
    if (request.tool === "get_selection") return this.result(request, { operationIds: this.selected, count: this.selected.length });
    if (request.tool === "list_machine_groups") return this.result(request, [{ id: "mill", name: "Mill machine group", type: "mill" }]);
    if (request.tool === "list_operations") return { ok: true, tool: request.tool, data: this.operations.map(item => ({ ...item })) };
    if (request.tool === "find_operations") {
      const query = String(a.query ?? "").toLowerCase();
      return this.result(request, this.operations.filter(item => !query || Object.values(item).some(value => String(value).toLowerCase().includes(query))));
    }
    if (["get_operation", "inspect"].includes(request.tool)) return { ok: true, tool: request.tool, data: { ...operation } };
    if (request.tool === "get_operation_parameters") return this.result(request, { operationId: operation.id, parameters: { feed: feed, speed: 12000, stepdown: 2 } });
    if (request.tool === "get_stock") return this.result(request, { dimensions: { x: 110, y: 90, z: 30 }, units: "mm" });
    if (request.tool === "get_wcs") return this.result(request, { name: "WCS 1", origin: [0, 0, 0], axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } });
    if (request.tool === "list_tools") return this.result(request, [{ number: 1, name: "6mm flat end mill", diameter: 6, units: "mm" }]);
    if (request.tool === "get_toolpath_status") return this.result(request, { operationId: operation.id, generated: true, valid: true, collisionState: "not_checked" });
    if (request.tool === "get_post_processor") return this.result(request, { name: "fixture-post", extension: ".nc", machine: "mock-mill" });
    if (request.tool === "estimate_cycle_time") return this.result(request, { operationId: operation.id, seconds: 42, confidence: "fixture" });
    if (request.tool === "compare_toolpaths") return this.result(request, { changed: false, added: 0, removed: 0, modified: 0 });
    if (request.tool === "measure") return { ok: true, tool: request.tool, data: { path: a.path ?? "operation.feed", value: feed, unit: "units/min", operationId: operation.id } };
    if (request.tool === "assert") { const pass = Number(a.equals) === feed; return { ok: pass, tool: request.tool, data: { pass, path: a.path ?? "operation.feed", actual: feed, expected: a.equals, operationId: operation.id } }; }
    if (request.tool === "capture_view") return { ok: true, tool: request.tool, data: { format: "svg", placeholder: true, image: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%25' height='100%25' fill='%23222'/><text x='16' y='95' fill='white'>Mock Mastercam view</text></svg>" } };
    if (request.tool === "set_feed_speed") {
      const before = { feed }; const value = Number(a.feed ?? feed);
      if (!Number.isFinite(value) || value <= 0) return { ok: false, tool: request.tool, error: { code: "INVALID_FEED", message: "feed must be a finite positive number" } };
      const after = { feed: value };
      if (!a.dryRun) operation.feed = after.feed;
      this.record({ timestamp: new Date().toISOString(), tool: request.tool, operationId: operation.id, before, after, dryRun: Boolean(a.dryRun) });
      return { ok: true, tool: request.tool, data: { applied: !a.dryRun }, receipt: { before, after, dryRun: Boolean(a.dryRun) } };
    }
    if (request.tool === "preview_change") return { ok: true, tool: request.tool, data: { operation: "set_feed_speed", before: { feed }, after: { feed: Number(a.feed ?? feed) }, requiresRegeneration: true, rollbackAvailable: true } };
    if (request.tool === "rollback_change") { const value = Number(a.beforeFeed); if (!Number.isFinite(value) || value <= 0) return { ok: false, tool: request.tool, error: { code: "INVALID_ROLLBACK", message: "beforeFeed must be a finite positive number" } }; const before = { feed }; operation.feed = value; this.record({ timestamp: new Date().toISOString(), tool: request.tool, operationId: operation.id, before, after: { feed: value }, rollback: true }); return { ok: true, tool: request.tool, data: { applied: true }, receipt: { before, after: { feed: value }, rollback: true } }; }
    if (request.tool === "regenerate_toolpath") return this.result(request, { operationIds: a.operationIds ?? [operation.id], regenerated: true, progress: ["queued", "generating", "complete"] });
    if (request.tool === "run_simulation") return this.result(request, { state: "complete", seconds: 3, collisions: 0, warnings: [] });
    if (request.tool === "detect_collisions") return this.result(request, { collisions: [], checkedOperations: a.operationIds ?? [operation.id] });
    if (request.tool === "get_version_report") return this.result(request, { mastercam: "fixture", netHook: "fixture", supported: ["mock"], liveMappingsVerified: false });
    if (request.tool === "client_setup_check") return this.result(request, { codex: "not_checked", claude: "not_checked", http: "available", guidance: "Run the installer with ConfigureClients on Windows" });
    if (request.tool === "get_audit_history") return this.result(request, this.history);
    return { ok: true, tool: request.tool, data: { fixture: true, request: a } };
  }

  private result(request: Request, data: unknown): ToolResult { return { ok: true, tool: request.tool, data }; }

  private record(entry: Record<string, unknown>) {
    this.history.push(entry);
    try { mkdirSync(dirname(this.auditPath), { recursive: true }); writeFileSync(this.auditPath, JSON.stringify(this.history.slice(-500), null, 2)); } catch { /* audit persistence must not block the machining request */ }
  }

  private operation(id: unknown) {
    return this.operations.find(item => String(item.id) === String(id ?? this.operations[0]?.id)) ?? this.operations[0];
  }
}

export function request(tool: string, args: Record<string, unknown> = {}): Request { return { id: randomUUID(), tool, arguments: args }; }
