import { randomUUID } from "node:crypto";
import { BridgeClient } from "./transport/bridge-client.js";
import type { BridgeClientOptions } from "./transport/bridge-client.js";
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
  "get_dirty_toolpaths", "get_selected_entities", "measure", "inspect", "verify_change"
]);

const IDEMPOTENT_READS = new Set([
  "mastercam_status", "mastercam_capabilities", "get_version_report", "list_operations",
  "get_operation", "get_operation_parameters", "list_tools", "get_stock", "get_wcs",
  "get_active_part", "get_machine_context", "get_programming_context", "discover_capabilities",
  "find_operations", "verify_change"
]);

const READ_DEADLINES_MS: Record<string, number> = {
  mastercam_status: 2000,
  mastercam_capabilities: 5000,
  get_version_report: 5000
};
const DEFAULT_READ_DEADLINE_MS = 10_000;
const MUTATION_DEADLINE_MS = 60_000;
const FAST_CACHE_TTL_MS = 250;

type CachedRead = { expiresAt: number; response: BridgeResponse };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export type LiveBackendOptions = BridgeClientOptions;

export class LiveBackend implements Backend {
  private readonly client: BridgeClient;
  private readonly scheduler = new Scheduler({ maxConcurrentReads: 4, maxConcurrentMutations: 1 });
  private readonly inFlightReads = new Map<string, Promise<BridgeResponse>>();
  private readonly fastCache = new Map<string, CachedRead>();
  private readonly unsubscribeEvents: () => void;

  constructor(options: LiveBackendOptions) {
    this.client = new BridgeClient(options);
    this.unsubscribeEvents = this.client.onEvent(() => {
      // Native document/selection/toolpath events become authoritative cache
      // invalidation once release-specific adapters begin emitting them.
      this.fastCache.clear();
    });
  }

  get breaker() {
    return this.client.breaker;
  }

  async call(
    request: { id: string; tool: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult> {
    const idempotentRead = IDEMPOTENT_READS.has(request.tool);
    const deadlineMs = READ_TOOLS.has(request.tool)
      ? READ_DEADLINES_MS[request.tool] ?? DEFAULT_READ_DEADLINE_MS
      : MUTATION_DEADLINE_MS;
    const bridgeIdempotencyKey =
      typeof request.arguments?.idempotencyKey === "string"
        ? request.arguments.idempotencyKey
        : undefined;

    try {
      const lane = READ_TOOLS.has(request.tool) ? "read" : "mutation";
      const response = await this.scheduler.schedule({
        lane,
        documentKey: "doc:live",
        priority: lane === "mutation" ? "high" : "normal",
        run: () => this.callBridge(
          request.tool,
          request.arguments,
          deadlineMs,
          idempotentRead,
          options?.signal,
          bridgeIdempotencyKey
        )
      });

      if (lane === "mutation") this.fastCache.clear();
      return this.envelope(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const colon = message.indexOf(":");
      const code = colon === -1 ? message : message.slice(0, colon);
      const retryable = code === "TIMEOUT" || code === "BACKEND_UNAVAILABLE" || code === "RATE_LIMITED";
      const knownCodes = new Set([
        "TIMEOUT", "CANCELLED", "BACKEND_UNAVAILABLE", "RATE_LIMITED", "OPERATION_NOT_FOUND",
        "TARGET_REQUIRED", "STALE_PREVIEW", "STALE_STATE", "RESPONSE_TOO_LARGE",
        "REQUEST_TOO_LARGE", "UNSUPPORTED_CAPABILITY", "UNSUPPORTED_TOOL",
        "APPROVAL_TOKEN_INVALID", "APPROVAL_TOKEN_EXPIRED", "IDEMPOTENCY_CONFLICT",
        "PROFILE_DENIED", "MASTERCAM_API_ERROR"
      ]);
      return {
        ok: false,
        tool: request.tool,
        error: {
          code: knownCodes.has(code) ? code : "BACKEND_UNAVAILABLE",
          message,
          retryable
        }
      };
    }
  }

  private callBridge(
    tool: string,
    args: Record<string, unknown> | undefined,
    deadlineMs: number,
    idempotentRead: boolean,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<BridgeResponse> {
    if (!idempotentRead) {
      return withRetry(
        { idempotent: false, maxAttempts: 1 },
        () => this.client.call(tool, args, deadlineMs, signal, idempotencyKey)
      );
    }

    const key = `${tool}:${canonical(args ?? {})}`;
    const cached = this.fastCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.response);
    if (cached) this.fastCache.delete(key);

    const existing = this.inFlightReads.get(key);
    if (existing) return existing;

    const promise = withRetry(
      { idempotent: true, maxAttempts: 3, deadlineMs },
      (_attempt, remainingMs) => this.client.call(tool, args, remainingMs, signal, idempotencyKey)
    ).then(response => {
      if (tool === "mastercam_status" || tool === "mastercam_capabilities") {
        this.fastCache.set(key, { expiresAt: Date.now() + FAST_CACHE_TTL_MS, response });
      }
      return response;
    }).finally(() => {
      if (this.inFlightReads.get(key) === promise) this.inFlightReads.delete(key);
    });

    this.inFlightReads.set(key, promise);
    return promise;
  }

  private envelope(request: { id: string; tool: string }, response: BridgeResponse): ToolResult {
    return {
      ok: response.ok,
      tool: response.tool || request.tool,
      data: response.data,
      error: response.error,
      receipt: response.receipt,
      live: true,
      ...(response.documentRevision ? { documentRevision: response.documentRevision } : {})
    };
  }

  async close(): Promise<void> {
    this.unsubscribeEvents();
    this.fastCache.clear();
    this.inFlightReads.clear();
    await this.client.close();
  }
}

export function newRequestId(): string {
  return randomUUID();
}
