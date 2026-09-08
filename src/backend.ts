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
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Mastercam named pipe timeout")); }, 15000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", chunk => { buffer += chunk; const line = buffer.split("\n")[0]; if (!line) return; clearTimeout(timer); socket.end(); try { resolve((JSON.parse(line) as Response).result); } catch (e) { reject(e); } });
      socket.on("error", e => { clearTimeout(timer); reject(e); });
    });
  }
}

export class MockBackend implements Backend {
  private feed = 35;
  async call(request: Request): Promise<ToolResult> {
    const a = request.arguments ?? {};
    if (request.tool === "mastercam_status") return { ok: true, tool: request.tool, data: { connected: true, backend: "mock", version: "fixture" } };
    if (request.tool === "list_operations") return { ok: true, tool: request.tool, data: [{ id: 4, name: "Facing", type: "mill", feed: this.feed }] };
    if (request.tool === "get_operation") return { ok: true, tool: request.tool, data: { id: a.operationId ?? 4, name: "Facing", feed: this.feed } };
    if (request.tool === "set_feed_speed") {
      const before = { feed: this.feed }; const after = { feed: Number(a.feed ?? this.feed) };
      if (!a.dryRun) this.feed = after.feed;
      return { ok: true, tool: request.tool, data: { applied: !a.dryRun }, receipt: { before, after, dryRun: Boolean(a.dryRun) } };
    }
    if (request.tool === "mastercam_capabilities") return { ok: true, tool: request.tool, data: { profile: "mock", live: false } };
    return { ok: true, tool: request.tool, data: { fixture: true, request: a } };
  }
}

export function request(tool: string, args: Record<string, unknown> = {}): Request { return { id: randomUUID(), tool, arguments: args }; }
