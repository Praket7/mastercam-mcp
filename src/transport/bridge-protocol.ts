export const BRIDGE_PROTOCOL_VERSION = 2;

export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  tool: string;
  arguments?: Record<string, unknown>;
  deadline?: string;
  idempotencyKey?: string;
}

export type BridgeCancel = { type: "cancel"; requestId: string };
export type BridgeEvent = { type: "event"; event: string; [key: string]: unknown };

export interface BridgeErrorShape { code: string; message: string; retryable?: boolean }

export interface BridgeResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: BridgeErrorShape;
  receipt?: unknown;
  live?: boolean;
  mastercamVersion?: string;
  adapterVersion?: string;
  documentRevision?: string;
  durationMs?: number;
}

export function encodeRequest(request: BridgeRequest): string {
  return JSON.stringify({ type: "request", ...request });
}

export function encodeCancel(requestId: string): string {
  return JSON.stringify({ type: "cancel", requestId } satisfies BridgeCancel);
}

export type ParsedFrame =
  | { kind: "response"; response: BridgeResponse }
  | { kind: "event"; event: BridgeEvent };

export function parseFrame(text: string): ParsedFrame {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed.type === "event") return { kind: "event", event: parsed as unknown as BridgeEvent };
  return { kind: "response", response: parsed as unknown as BridgeResponse };
}
