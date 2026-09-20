import net from "node:net";
import { randomUUID } from "node:crypto";
import { FrameReader, encodeFrame } from "./framing.js";
import { BRIDGE_PROTOCOL_VERSION, encodeRequest, encodeCancel, parseFrame } from "./bridge-protocol.js";
import type { BridgeResponse } from "./bridge-protocol.js";
import { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker.js";

export interface BridgeClientOptions {
  endpoint: string;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
}

interface Pending {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancelSent?: boolean;
}

/**
 * Manages a single persistent connection to the native bridge. Requests are
 * correlated by requestId; the connection is re-established lazily after any
 * failure. A circuit breaker prevents hammering a dead endpoint.
 */
export class BridgeClient {
  private socket: net.Socket | undefined;
  private connecting: Promise<net.Socket> | undefined;
  private pending = new Map<string, Pending>();
  private reader = new FrameReader();
  private readonly options: Required<BridgeClientOptions>;
  readonly breaker: CircuitBreaker;

  constructor(options: BridgeClientOptions) {
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs ?? 2000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
      endpoint: options.endpoint
    };
    this.breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5000 });
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async call(tool: string, args: Record<string, unknown> | undefined, deadlineMs: number, signal?: AbortSignal, idempotencyKey?: string): Promise<BridgeResponse> {
    return this.breaker.execute(async () => {
      const requestId = randomUUID();
      const socket = await this.ensureConnected();
      return new Promise<BridgeResponse>((resolve, reject) => {
        const payload = encodeRequest({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId,
          tool,
          arguments: args,
          deadline: new Date(Date.now() + deadlineMs).toISOString(),
          ...(idempotencyKey ? { idempotencyKey } : {})
        });
        const timer = setTimeout(() => finish(new Error(`TIMEOUT: ${tool} exceeded ${deadlineMs}ms deadline`)), deadlineMs);
        const pending: Pending = { resolve, reject, timer };
        this.pending.set(requestId, pending);

        const onAbort = () => {
          if (!pending.cancelSent) {
            pending.cancelSent = true;
            this.safeWrite(socket, encodeCancel(requestId));
          }
          finish(new Error("CANCELLED: request cancelled by client"));
        };
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        const finish = (error: Error, response?: BridgeResponse) => {
          clearTimeout(timer);
          if (this.pending.get(requestId) === pending) this.pending.delete(requestId);
          signal?.removeEventListener("abort", onAbort);
          if (error && !response) reject(error);
          else resolve(response!);
        };

        pending.resolve = resolve;
        pending.reject = reject;

        const registered = this.pending.get(requestId);
        if (!registered) { finish(new Error("CANCELLED: request cancelled before send")); return; }

        if (!this.safeWrite(socket, encodeFrame(payload))) {
          finish(new Error("BACKEND_UNAVAILABLE: bridge connection lost before send"));
        }
      });
    });
  }

  /** Best-effort cancel for requests that already timed out elsewhere. */
  cancelAll(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      pending.reject(new Error(reason));
      if (this.socket && !this.socket.destroyed) this.safeWrite(this.socket, encodeCancel(requestId));
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.cancelAll("CANCELLED: bridge client closing");
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    if (socket) await new Promise<void>(resolve => socket.end(() => resolve()));
  }

  private safeWrite(socket: net.Socket, payload: string): boolean {
    if (socket.destroyed) return false;
    try { socket.write(payload); return true; } catch { return false; }
  }

  private ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.options.endpoint);
      socket.setEncoding("utf8");
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("BACKEND_UNAVAILABLE: bridge connection timed out"));
      }, this.options.connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.attach(socket);
        resolve(socket);
      });
      socket.once("error", error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    this.connecting.finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.reader = new FrameReader(this.options.maxResponseBytes);
    socket.on("data", (chunk: string) => {
      let frames: string[];
      try { frames = this.reader.push(chunk); }
      catch (error) {
        this.failAllPending(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        let message: ReturnType<typeof parseFrame>;
        try { message = parseFrame(frame); }
        catch { continue; } // unparseable junk frame: ignore rather than fail the connection
        if (message.kind === "event") continue; // events not yet consumed by TS layer
        const response = message.response;
        const pending = this.pending.get(response.requestId);
        if (!pending) continue; // late response after timeout/cancel
        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response);
        else {
          const error = new Error(`${response.error?.code ?? "BACKEND_UNAVAILABLE"}: ${response.error?.message ?? "bridge call failed"}`);
          pending.reject(error);
        }
      }
    });
    socket.on("error", () => this.failAllPending(new Error("BACKEND_UNAVAILABLE: bridge socket error")));
    socket.on("close", () => {
      this.socket = undefined;
      this.failAllPending(new Error("BACKEND_UNAVAILABLE: bridge connection closed"));
    });
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function isCircuitOpen(error: unknown): error is CircuitBreakerOpenError {
  return error instanceof CircuitBreakerOpenError;
}
