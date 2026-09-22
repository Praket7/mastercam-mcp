import net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame } from "./protocol.js";
import { BRIDGE_PROTOCOL_VERSION, encodeRequest, encodeCancel, parseFrame } from "./bridge-protocol.js";
import type { BridgeResponse } from "./bridge-protocol.js";
import { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker.js";
import type { CircuitBreakerOptions } from "./circuit-breaker.js";

export interface BridgeClientOptions {
  endpoint: string;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
  circuitBreaker?: CircuitBreakerOptions;
}

interface Pending {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
  cancelSent?: boolean;
}

export class BridgeClient {
  private socket: net.Socket | undefined;
  private connecting: Promise<net.Socket> | undefined;
  private pending = new Map<string, Pending>();
  private readonly options: {
    endpoint: string;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    maxResponseBytes: number;
    circuitBreaker: CircuitBreakerOptions;
  };
  readonly breaker: CircuitBreaker;

  constructor(options: BridgeClientOptions) {
    this.options = {
      endpoint: options.endpoint,
      connectTimeoutMs: options.connectTimeoutMs ?? 2000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
      circuitBreaker: options.circuitBreaker ?? {
        failureThreshold: 3,
        cooldownMs: 5000,
        halfOpenSuccesses: 2
      }
    };
    this.breaker = new CircuitBreaker(this.options.circuitBreaker);
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async call(
    tool: string,
    args: Record<string, unknown> | undefined,
    deadlineMs: number,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<BridgeResponse> {
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

        let pending: Pending;
        const finish = (error?: Error, response?: BridgeResponse) => {
          clearTimeout(pending.timer);
          if (this.pending.get(requestId) === pending) this.pending.delete(requestId);
          pending.cleanup?.();
          if (error) reject(error);
          else if (response) resolve(response);
          else reject(new Error("BACKEND_UNAVAILABLE: bridge call ended without a response"));
        };

        const sendCancel = () => {
          if (pending.cancelSent) return;
          pending.cancelSent = true;
          this.safeWrite(socket, encodeFrame(encodeCancel(requestId)));
        };

        const onAbort = () => {
          sendCancel();
          finish(new Error("CANCELLED: request cancelled by client"));
        };

        const timer = setTimeout(() => {
          sendCancel();
          finish(new Error(`TIMEOUT: ${tool} exceeded ${deadlineMs}ms deadline`));
        }, deadlineMs);

        pending = {
          resolve,
          reject,
          timer,
          cleanup: () => signal?.removeEventListener("abort", onAbort)
        };
        this.pending.set(requestId, pending);

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        if (!this.safeWrite(socket, encodeFrame(payload))) {
          finish(new Error("BACKEND_UNAVAILABLE: bridge connection lost before send"));
        }
      });
    });
  }

  cancelAll(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (this.socket && !this.socket.destroyed && !pending.cancelSent) {
        pending.cancelSent = true;
        this.safeWrite(this.socket, encodeFrame(encodeCancel(requestId)));
      }
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.cancelAll("CANCELLED: bridge client closing");
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    if (socket && !socket.destroyed) {
      await new Promise<void>(resolve => socket.end(() => resolve()));
    }
  }

  private safeWrite(socket: net.Socket, payload: string | Buffer): boolean {
    if (socket.destroyed) return false;
    try {
      socket.write(payload);
      return true;
    } catch {
      return false;
    }
  }

  private ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.options.endpoint);
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

    this.connecting.finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private buffer = Buffer.alloc(0);

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setTimeout(this.options.idleTimeoutMs, () => {
      this.failAllPending(new Error("BACKEND_UNAVAILABLE: bridge connection idle timeout"));
      socket.destroy();
    });

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 8) {
        const len = Number(this.buffer.readBigUInt64LE(0));
        if (!Number.isSafeInteger(len) || len < 0 || len > this.options.maxResponseBytes) {
          this.failAllPending(new Error(
            `RESPONSE_TOO_LARGE: frame exceeded ${this.options.maxResponseBytes} bytes`
          ));
          socket.destroy();
          return;
        }
        if (this.buffer.length < 8 + len) break;

        const payload = this.buffer.subarray(8, 8 + len);
        this.buffer = this.buffer.subarray(8 + len);

        let message: ReturnType<typeof parseFrame>;
        try {
          message = parseFrame(payload.toString("utf8"));
        } catch (error) {
          this.failAllPending(new Error(
            `BACKEND_UNAVAILABLE: invalid bridge response: ${error instanceof Error ? error.message : String(error)}`
          ));
          socket.destroy();
          return;
        }

        if (message.kind === "event") continue;
        const response = message.response;
        const pending = this.pending.get(response.requestId);
        if (!pending) continue;

        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.cleanup?.();

        if (response.ok) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(
            `${response.error?.code ?? "BACKEND_UNAVAILABLE"}: ${response.error?.message ?? "bridge call failed"}`
          ));
        }
      }
    });

    socket.on("error", () => {
      this.failAllPending(new Error("BACKEND_UNAVAILABLE: bridge socket error"));
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.buffer = Buffer.alloc(0);
      this.failAllPending(new Error("BACKEND_UNAVAILABLE: bridge connection closed"));
    });
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function isCircuitOpen(error: unknown): error is CircuitBreakerOpenError {
  return error instanceof CircuitBreakerOpenError;
}
