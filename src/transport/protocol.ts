export interface BridgeClient {
  connect(): Promise<void>;
  request(tool: string, args: Record<string, unknown>, options?: { deadline?: Date; idempotencyKey?: string; priority?: number }): Promise<BridgeResponse>;
  cancel(requestId: string): void;
  close(): Promise<void>;
  isConnected(): boolean;
  on(event: "connect" | "close" | "error", listener: (arg?: Error) => void): this;
  on(event: "event", listener: (event: BridgeEvent) => void): this;
}

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
}

export type BridgeMessage = BridgeResponse | BridgeEvent;

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
export const MAX_REQUEST_METADATA_SIZE = 1024 * 1024;
export const MAX_RESPONSE_SIZE = 4 * 1024 * 1024;
export const FRAME_HEADER_SIZE = 8;

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_SIZE) throw new Error(`Payload exceeds maximum frame size: ${payload.length}`);
  const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setBigUint64(0, BigInt(payload.length), true);
  frame.set(payload, FRAME_HEADER_SIZE);
  return frame;
}

export function decodeFrame(buffer: Uint8Array): { payload: Uint8Array; remaining: Uint8Array } | null {
  if (buffer.length < FRAME_HEADER_SIZE) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const length = Number(view.getBigUint64(0, true));
  if (length < 0 || length > MAX_FRAME_SIZE) throw new Error(`Invalid frame length: ${length}`);
  const totalSize = FRAME_HEADER_SIZE + length;
  if (buffer.length < totalSize) return null;
  const payload = buffer.slice(FRAME_HEADER_SIZE, totalSize);
  const remaining = buffer.slice(totalSize);
  return { payload, remaining };
}