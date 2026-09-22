import { MAX_FRAME_SIZE } from "./protocol.js";
export const MAX_FRAME_BYTES = MAX_FRAME_SIZE;

/**
 * Incremental frame decoder for the bridge's 8-byte little-endian length
 * prefix. Unlike Buffer.concat-based accumulation, every payload byte is
 * copied at most once into its final frame buffer regardless of chunking.
 */
export class FrameReader {
  private readonly header = Buffer.allocUnsafe(8);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private expectedPayloadBytes = -1;
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string | Buffer): string[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const frames: string[] = [];
    let offset = 0;

    while (offset < data.length) {
      if (this.expectedPayloadBytes < 0) {
        const headerRemaining = 8 - this.headerBytes;
        const take = Math.min(headerRemaining, data.length - offset);
        data.copy(this.header, this.headerBytes, offset, offset + take);
        this.headerBytes += take;
        offset += take;

        if (this.headerBytes < 8) break;

        const length = Number(this.header.readBigUInt64LE(0));
        if (!Number.isSafeInteger(length) || length < 0 || length > this.maxFrameBytes) {
          this.reset();
          throw new Error(`RESPONSE_TOO_LARGE: frame exceeded ${this.maxFrameBytes} bytes`);
        }
        this.headerBytes = 0;
        this.expectedPayloadBytes = length;
        this.payloadBytes = 0;
        this.payload = length === 0 ? undefined : Buffer.allocUnsafe(length);

        if (length === 0) {
          frames.push("");
          this.expectedPayloadBytes = -1;
          continue;
        }
      }

      const payload = this.payload;
      if (!payload) continue;
      const remaining = this.expectedPayloadBytes - this.payloadBytes;
      const take = Math.min(remaining, data.length - offset);
      data.copy(payload, this.payloadBytes, offset, offset + take);
      this.payloadBytes += take;
      offset += take;

      if (this.payloadBytes === this.expectedPayloadBytes) {
        frames.push(payload.toString("utf8"));
        this.payload = undefined;
        this.payloadBytes = 0;
        this.expectedPayloadBytes = -1;
      }
    }

    return frames;
  }

  reset(): void {
    this.headerBytes = 0;
    this.payload = undefined;
    this.payloadBytes = 0;
    this.expectedPayloadBytes = -1;
  }

  get pendingBytes(): number {
    return this.headerBytes + this.payloadBytes;
  }

  /** Legacy diagnostic accessor retained for compatibility. */
  get pending(): string {
    if (this.payload && this.payloadBytes > 0) {
      return this.payload.subarray(0, this.payloadBytes).toString("utf8");
    }
    return "";
  }
}
