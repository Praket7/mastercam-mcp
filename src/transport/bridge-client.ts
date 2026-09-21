import net from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { defaultPipe } from "../platform.js";
import { CircuitBreaker, CircuitState } from "./reconnect.js";

export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  type: "request" | "cancel" | "ping";
  tool: string;
  arguments?: Record<string, unknown>;
  deadline?: string;
  idempotencyKey?: string;
  priority?: number;
}

export interface BridgeResponse {
  protocolVersion: number;
  requestId: string;
  type: "response" | "event" | "error";
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean; remediation?: string };
  executionDurationMs?: number;
  adapterVersion?: string;
  mastercamVersion?: string;
  documentRevision?: string;
}

export interface BridgeEvent {
  protocolVersion: number;
  eventId: string;
  event: string;
  timestamp: string;
  data?: unknown;
  type?: "event";
}

export type BridgeMessage = BridgeResponse | BridgeEvent;

export class BridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (value: BridgeResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private connected = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pipeName: string;
  private readonly maxFrameSize: number;
  private readonly requestTimeout: number;
  private closed = false;
  private circuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    isRetryableError: (error: Error) => {
      const message = error.message.toLowerCase();
      const transportErrors = [
        "econnrefused", "econnreset", "etimedout", "enotfound", 
        "ehostunreach", "epipe", "socket hang up", "connection timeout",
        "connection refused", "connection reset", "network"
      ];
      return transportErrors.some(e => message.includes(e));
    }
  });

  constructor(pipeName?: string, options: { maxFrameSize?: number; requestTimeout?: number } = {}) {
    super();
    this.pipeName = pipeName ?? defaultPipe();
    this.maxFrameSize = options.maxFrameSize ?? 16 * 1024 * 1024;
    this.requestTimeout = options.requestTimeout ?? 30000;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipeName);
      this.socket = socket;

      socket.on("connect", () => {
        this.connected = true;
        this.connecting = false;
        this.circuitBreaker.reset();
        this.emit("connect");
        resolve();
      });

      socket.on("data", (chunk: Buffer) => this.onData(chunk));

      socket.on("error", (err: Error) => {
        if (this.connecting) {
          this.connecting = false;
          reject(err);
        }
        this.emit("error", err);
      });

      socket.on("close", () => {
        this.connected = false;
        this.connecting = false;
        this.emit("close");
        this.scheduleReconnect();
      });

      socket.setTimeout(5000, () => {
        if (this.connecting) {
          this.connecting = false;
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      });
    });
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && !this.connected && !this.connecting) {
        this.connect().catch(() => { });
      }
    }, 1000);
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const length = this.buffer.readBigUInt64LE(0);
      if (length > this.maxFrameSize) {
        this.emit("error", new Error(`Frame size ${length} exceeds maximum ${this.maxFrameSize}`));
        this.buffer = Buffer.alloc(0);
        return;
      }
      const totalSize = 8 + Number(length);
      if (this.buffer.length < totalSize) break;
      const frame = this.buffer.subarray(8, totalSize);
      this.buffer = this.buffer.subarray(totalSize);
      this.processFrame(frame);
    }
  }

  private processFrame(frame: Buffer) {
    try {
      const message = JSON.parse(frame.toString("utf8")) as BridgeMessage;
      const isEvent = "event" in message && (message as BridgeEvent).event !== undefined;
      if (isEvent) {
        this.emit("event", message as BridgeEvent);
        return;
      }
      const response = message as BridgeResponse;
      const pending = this.pending.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(response.requestId);
        if (response.type === "error" || response.error) {
          pending.reject(new Error(response.error?.message ?? "Unknown error"));
        } else {
          pending.resolve(response);
        }
      }
    } catch (e) {
      this.emit("error", new Error(`Failed to parse frame: ${e}`));
    }
  }

  async request(tool: string, args: Record<string, unknown> = {}, options: { deadline?: Date; idempotencyKey?: string; priority?: number; signal?: AbortSignal } = {}): Promise<BridgeResponse> {
    if (!this.connected) await this.connect();
    const requestId = randomUUID();
    const request: BridgeRequest = {
      protocolVersion: 2,
      requestId,
      type: "request",
      tool,
      arguments: args,
      deadline: options.deadline?.toISOString(),
      idempotencyKey: options.idempotencyKey,
      priority: options.priority ?? 0
    };

    return this.circuitBreaker.execute(async () => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Request timeout after ${this.requestTimeout}ms`));
        }, this.requestTimeout);

        let settled = false;
        let finish = (error?: Error, result?: BridgeResponse) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(requestId);
          error ? reject(error) : resolve(result!);
        };

        if (options.signal) {
          if (options.signal.aborted) {
            finish(new Error("CANCELLED: request cancelled by client"));
            return;
          }
          const onAbort = () => {
            finish(new Error("CANCELLED: request cancelled by client"));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
          const originalFinish = finish;
          finish = (error?: Error, result?: BridgeResponse) => {
            options.signal?.removeEventListener("abort", onAbort);
            originalFinish(error, result);
          };
        }

        this.pending.set(requestId, { resolve: finish as any, reject: finish as any, timer });
        this.send(request);
      });
    });
  }

  cancel(requestId: string): void {
    const request: BridgeRequest = { protocolVersion: 2, requestId, type: "cancel", tool: "" };
    this.send(request);
  }

  private send(message: BridgeRequest | BridgeResponse) {
    if (!this.socket || !this.connected) throw new Error("Not connected");
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.alloc(8 + payload.length);
    frame.writeBigUInt64LE(BigInt(payload.length), 0);
    payload.copy(frame, 8);
    this.socket.write(frame);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error("Client closed")); }
    this.pending.clear();
    return new Promise(resolve => {
      if (this.socket) {
        this.socket.once("close", () => resolve());
        this.socket.destroy();
      } else resolve();
    });
  }

  isConnected(): boolean { return this.connected; }
  getCircuitBreakerState(): CircuitState { return this.circuitBreaker.getState(); }
}