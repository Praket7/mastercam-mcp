import net from "node:net";
import { randomUUID } from "node:crypto";
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
  constructor(fixture?: { feed?: number; operations?: Array<Record<string, unknown>> }) {
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
    if (request.tool === "mastercam_capabilities") return { ok: true, tool: request.tool, data: { profile: "mock", live: false, fixture: true } };
    if (request.tool === "list_operations") return { ok: true, tool: request.tool, data: this.operations.map(item => ({ ...item })) };
    if (["get_operation", "inspect"].includes(request.tool)) return { ok: true, tool: request.tool, data: { ...operation } };
    if (request.tool === "measure") return { ok: true, tool: request.tool, data: { path: a.path ?? "operation.feed", value: feed, unit: "units/min", operationId: operation.id } };
    if (request.tool === "assert") { const pass = Number(a.equals) === feed; return { ok: pass, tool: request.tool, data: { pass, path: a.path ?? "operation.feed", actual: feed, expected: a.equals, operationId: operation.id } }; }
    if (request.tool === "capture_view") return { ok: true, tool: request.tool, data: { format: "svg", placeholder: true, image: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='100%25' height='100%25' fill='%23222'/><text x='16' y='95' fill='white'>Mock Mastercam view</text></svg>" } };
    if (request.tool === "set_feed_speed") {
      const before = { feed }; const value = Number(a.feed ?? feed);
      if (!Number.isFinite(value) || value <= 0) return { ok: false, tool: request.tool, error: { code: "INVALID_FEED", message: "feed must be a finite positive number" } };
      const after = { feed: value };
      if (!a.dryRun) operation.feed = after.feed;
      return { ok: true, tool: request.tool, data: { applied: !a.dryRun }, receipt: { before, after, dryRun: Boolean(a.dryRun) } };
    }
    if (request.tool === "preview_change") return { ok: true, tool: request.tool, data: { operation: "set_feed_speed", before: { feed }, after: { feed: Number(a.feed ?? feed) }, requiresRegeneration: true, rollbackAvailable: true } };
    if (request.tool === "rollback_change") { const value = Number(a.beforeFeed); if (!Number.isFinite(value) || value <= 0) return { ok: false, tool: request.tool, error: { code: "INVALID_ROLLBACK", message: "beforeFeed must be a finite positive number" } }; const before = { feed }; operation.feed = value; return { ok: true, tool: request.tool, data: { applied: true }, receipt: { before, after: { feed: value }, rollback: true } }; }
    return { ok: true, tool: request.tool, data: { fixture: true, request: a } };
  }

  private operation(id: unknown) {
    return this.operations.find(item => String(item.id) === String(id ?? this.operations[0]?.id)) ?? this.operations[0];
  }
}

export function request(tool: string, args: Record<string, unknown> = {}): Request { return { id: randomUUID(), tool, arguments: args }; }
