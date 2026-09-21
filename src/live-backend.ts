import { BridgeClient } from "./transport/bridge-client.js";
import type { Backend } from "./backend.js";
import type { Request, ToolResult } from "./contracts.js";

export class LiveBackend implements Backend {
  private client: BridgeClient;
  private connected = false;

  constructor(pipeName?: string) {
    this.client = new BridgeClient(pipeName);
  }

  async call(request: Request): Promise<ToolResult> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }

    try {
      const response = await this.client.request(request.tool, request.arguments, {
        idempotencyKey: request.id
      });

      if (response.error) {
        return { ok: false, tool: request.tool, error: response.error };
      }
      return { ok: true, tool: request.tool, data: response.result };
    } catch (error) {
      return { ok: false, tool: request.tool, error: { code: "BACKEND_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

