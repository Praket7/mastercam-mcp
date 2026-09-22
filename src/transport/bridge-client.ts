import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { encodeFrame } from "./protocol.js";
import { FrameReader } from "./framing.js";
import { BRIDGE_PROTOCOL_VERSION, encodeRequest, encodeCancel, parseFrame } from "./bridge-protocol.js";
import type { BridgeEvent, BridgeResponse } from "./bridge-protocol.js";
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
  private readonly reader: FrameReader;
  private readonly eventListeners = new Set<(event: BridgeEvent) => void>();
  private writeChain: Promise<void> = Promise.resolve();
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
    this.reader = new FrameReader(this.options.maxResponseBytes);
    this.breaker = new CircuitBreaker(this.options.circuitBreaker);
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
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

        const pending = { resolve, reject } as Pending;
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
          void this.enqueueWrite(socket, encodeFrame(encodeCancel(requestId))).catch(() => undefined);
        };

        const onAbort = () => {
          sendCancel();
          finish(new Error("CANCELLED: request cancelled by client"));
        };

        pending.timer = setTimeout(() => {
          sendCancel();
          finish(new Error(`TIMEOUT: ${tool} exceeded ${deadlineMs}ms deadline`));
        }, deadlineMs);
        pending.timer.unref?.();
        pending.cleanup = () => signal?.removeEventListener("abort", onAbort);
        this.pending.set(requestId, pending);

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        void this.enqueueWrite(socket, encodeFrame(payload)).catch(() => {
          finish(new Error("BACKEND_UNAVAILABLE: bridge connection lost before send"));
        });
      });
    });
  }

  cancelAll(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (this.socket && !this.socket.destroyed && !pending.cancelSent) {
        pending.cancelSent = true;
        void this.enqueueWrite(this.socket, encodeFrame(encodeCancel(requestId))).catch(() => undefined);
      }
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.cancelAll("CANCELLED: bridge client closing");
    await this.writeChain.catch(() => undefined);
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    if (socket && !socket.destroyed) {
      await new Promise<void>(resolve => socket.end(() => resolve()));
    }
  }

  private enqueueWrite(socket: net.Socket, payload: string | Buffer): Promise<void> {
    const write = async () => {
      if (socket.destroyed) {
        throw new Error("BACKEND_UNAVAILABLE: bridge socket is closed");
      }
      let writable: boolean;
      try {
        writable = socket.write(payload);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      if (!writable) {
        await once(socket, "drain");
      }
    };
    const next = this.writeChain.then(write, write);
    this.writeChain = next.catch(() => undefined);
    return next;
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
      timer.unref?.();

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

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.reader.reset();
    socket.setTimeout(this.options.idleTimeoutMs, () => {
      // A connection may be byte-idle while Mastercam is legitimately executing
      // a long request. Per-request deadlines own active work; the connection
      // idle timeout only reaps truly idle bridge connections.
      if (this.pending.size === 0) socket.destroy();
    });

    socket.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = this.reader.push(chunk);
      } catch (error) {
        this.failAllPending(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
        return;
      }

      for (const text of frames) {
        let message: ReturnType<typeof parseFrame>;
        try {
          message = parseFrame(text);
        } catch (error) {
          this.failAllPending(new Error(
            `BACKEND_UNAVAILABLE: invalid bridge response: ${error instanceof Error ? error.message : String(error)}`
          ));
          socket.destroy();
          return;
        }

        if (message.kind === "event") {
          for (const listener of this.eventListeners) {
            try { listener(message.event); } catch { }
          }
          continue;
        }

        const response = message.response;
        const pending = this.pending.get(response.requestId);
        if (!pending) continue;

        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.cleanup?.();

        if (response.ok) {
          pending.resolve(response);
        } else {
          const error = new Error(
            `${response.error?.code ?? "BACKEND_UNAVAILABLE"}: ${response.error?.message ?? "bridge call failed"}`
          ) as Error & { retryable?: boolean };
          error.retryable = response.error?.retryable;
          pending.reject(error);
        }
      }
    });

    socket.on("error", () => {
      this.failAllPending(new Error("BACKEND_UNAVAILABLE: bridge socket error"));
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.reader.reset();
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
