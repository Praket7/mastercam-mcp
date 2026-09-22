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

const REVISION_CACHEABLE_READS = new Set([
  "get_active_part", "list_operations", "get_operation", "get_operation_parameters",
  "list_tools", "get_stock", "get_wcs", "get_machine_context", "get_programming_context",
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
const REVISION_CACHE_TTL_MS = 1000;

type CachedRead = { expiresAt: number; response: BridgeResponse };
type ReadFlight = {
  promise: Promise<BridgeResponse>;
  controller: AbortController;
  waiters: number;
};

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
  private readonly inFlightReads = new Map<string, ReadFlight>();
  private readonly readCache = new Map<string, CachedRead>();
  private readonly unsubscribeEvents: () => void;

  constructor(options: LiveBackendOptions) {
    this.client = new BridgeClient(options);
    this.unsubscribeEvents = this.client.onEvent(() => {
      // Release adapters can emit document/selection/toolpath events. Until
      // then, revision-bound entries also carry a short TTL as a fail-safe.
      this.readCache.clear();
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

      if (lane === "mutation") this.readCache.clear();
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
        { idempotent: false, maxAttempts: 1, deadlineMs },
        (_attempt, remainingMs) => this.client.call(tool, args, remainingMs, signal, idempotencyKey)
      );
    }

    const key = `${tool}:${canonical(args ?? {})}`;
    const cached = this.readCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return this.resolveCached(cached.response, signal);
    if (cached) this.readCache.delete(key);

    let flight = this.inFlightReads.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = withRetry(
        { idempotent: true, maxAttempts: 3, deadlineMs },
        (_attempt, remainingMs) => this.client.call(
          tool,
          args,
          remainingMs,
          controller.signal,
          idempotencyKey
        )
      ).then(response => {
        this.cacheSuccessfulRead(key, tool, response);
        return response;
      }).finally(() => {
        const current = this.inFlightReads.get(key);
        if (current?.promise === promise) this.inFlightReads.delete(key);
      });
      flight = { promise, controller, waiters: 0 };
      this.inFlightReads.set(key, flight);
    }

    return this.waitForFlight(flight, signal);
  }

  private cacheSuccessfulRead(key: string, tool: string, response: BridgeResponse): void {
    if (tool === "mastercam_status" || tool === "mastercam_capabilities") {
      this.readCache.set(key, { expiresAt: Date.now() + FAST_CACHE_TTL_MS, response });
      return;
    }
    if (response.documentRevision && REVISION_CACHEABLE_READS.has(tool)) {
      this.readCache.set(key, { expiresAt: Date.now() + REVISION_CACHE_TTL_MS, response });
    }
  }

  private resolveCached(response: BridgeResponse, signal?: AbortSignal): Promise<BridgeResponse> {
    if (signal?.aborted) {
      return Promise.reject(new Error("CANCELLED: request cancelled by client"));
    }
    return Promise.resolve(response);
  }

  private waitForFlight(flight: ReadFlight, signal?: AbortSignal): Promise<BridgeResponse> {
    flight.waiters++;
    return new Promise<BridgeResponse>((resolve, reject) => {
      let settled = false;

      const finish = (error?: unknown, response?: BridgeResponse) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        flight.waiters = Math.max(0, flight.waiters - 1);
        if (error !== undefined) reject(error);
        else if (response) resolve(response);
        else reject(new Error("BACKEND_UNAVAILABLE: shared read completed without a response"));
      };

      const onAbort = () => {
        finish(new Error("CANCELLED: request cancelled by client"));
        if (flight.waiters === 0 && !flight.controller.signal.aborted) {
          flight.controller.abort(new Error("CANCELLED: all coalesced read callers cancelled"));
        }
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        response => finish(undefined, response),
        error => finish(error)
      );
    });
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
    this.readCache.clear();
    for (const flight of this.inFlightReads.values()) {
      if (!flight.controller.signal.aborted) flight.controller.abort();
    }
    this.inFlightReads.clear();
    await this.client.close();
  }
}

export function newRequestId(): string {
  return randomUUID();
}
