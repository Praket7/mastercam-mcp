import { randomUUID } from "node:crypto";
import { BridgeClient } from "./transport/bridge-client.js";
import type { BridgeResponse } from "./transport/bridge-protocol.js";
import { withRetry } from "./transport/reconnect.js";
import { Scheduler } from "./scheduler/request-scheduler.js";
import type { Backend, ToolResult } from "./backend.js";

const READ_TOOLS = new Set([
  "mastercam_status", "mastercam_capabilities", "get_active_part", "get_geometry_summary", "get_selection",
  "list_machine_groups", "get_machine_groups", "list_operations", "get_operation", "get_operation_parameters",
  "get_stock", "get_wcs", "list_tools", "get_tool", "get_toolpath_status", "get_post_processor",
  "estimate_cycle_time", "compare_toolpaths", "mastercam_doctor", "get_version_report", "discover_capabilities",
  "explain_operation", "get_operation_risks", "find_operations", "get_machine_context", "get_programming_context",
  "get_dirty_toolpaths", "get_selected_entities", "measure", "inspect"
]);

/** Reads that are safe to auto-retry on transport loss (REL-03). */
const IDEMPOTENT_READS = new Set([
  "mastercam_status", "mastercam_capabilities", "get_version_report", "list_operations",
  "get_operation", "get_operation_parameters", "list_tools", "get_stock", "get_wcs",
  "get_active_part", "get_machine_context", "discover_capabilities", "find_operations"
]);

const READ_DEADLINES_MS: Record<string, number> = {
  mastercam_status: 2000,
  mastercam_capabilities: 5000,
  get_version_report: 5000
};
const DEFAULT_READ_DEADLINE_MS = 10_000;
const MUTATION_DEADLINE_MS = 60_000;

export interface LiveBackendOptions {
  endpoint: string;
}

export class LiveBackend implements Backend {
  private readonly client: BridgeClient;
  private readonly scheduler = new Scheduler({ maxConcurrentReads: 4 });

  constructor(options: LiveBackendOptions) {
    this.client = new BridgeClient({ endpoint: options.endpoint });
  }

  get breaker() {
    return this.client.breaker;
  }

  async call(request: { id: string; tool: string; arguments?: Record<string, unknown> }): Promise<ToolResult> {
    const idempotentRead = IDEMPOTENT_READS.has(request.tool);
    const deadlineMs = READ_TOOLS.has(request.tool)
      ? READ_DEADLINES_MS[request.tool] ?? DEFAULT_READ_DEADLINE_MS
      : MUTATION_DEADLINE_MS;
    try {
      const lane = READ_TOOLS.has(request.tool) ? "read" : "mutation";
      const response = await this.scheduler.schedule({
        lane,
        documentKey: "doc:live",
        run: () => withRetry(
          { idempotent: idempotentRead, maxAttempts: 3 },
          () => this.client.call(request.tool, request.arguments, deadlineMs)
        )
      });
      return this.envelope(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const colon = message.indexOf(":");
      const code = colon === -1 ? message : message.slice(0, colon);
      const knownCodes = new Set(["TIMEOUT", "CANCELLED", "BACKEND_UNAVAILABLE", "OPERATION_NOT_FOUND", "TARGET_REQUIRED", "STALE_PREVIEW", "RESPONSE_TOO_LARGE"]);
      return {
        ok: false,
        tool: request.tool,
        error: {
          code: knownCodes.has(code) ? code : "BACKEND_UNAVAILABLE",
          message,
          retryable: idempotentRead
        }
      };
    }
  }

  private envelope(request: { id: string; tool: string }, response: BridgeResponse): ToolResult {
    return {
      ok: response.ok,
      tool: response.tool || request.tool,
      data: response.data,
      receipt: response.receipt,
      live: true,
      ...(response.documentRevision ? { documentRevision: response.documentRevision } : {})
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function newRequestId(): string {
  return randomUUID();
}
