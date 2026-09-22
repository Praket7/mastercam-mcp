import { MAX_FRAME_SIZE } from "./protocol.js";
export const MAX_FRAME_BYTES = MAX_FRAME_SIZE;

/**
 * FrameReader is now a thin wrapper around the canonical 8-byte protocol.
 * It maintains compatibility with the legacy API while using the new framing.
 */
export class FrameReader {
  private buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string | Buffer): string[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: string[] = [];

    while (this.buffer.length >= 8) {
      const len = Number(this.buffer.readBigUInt64LE(0));
      if (len < 0 || len > this.maxFrameBytes) {
        throw new Error(`RESPONSE_TOO_LARGE: frame exceeded ${this.maxFrameBytes} bytes`);
      }
      if (this.buffer.length < 8 + len) break;

      const payload = this.buffer.subarray(8, 8 + len);
      this.buffer = this.buffer.subarray(8 + len);
      frames.push(payload.toString("utf8"));
    }

    if (this.buffer.length > this.maxFrameBytes) {
      throw new Error(`RESPONSE_TOO_LARGE: buffered data exceeded ${this.maxFrameBytes} bytes without complete frame`);
    }

    return frames;
  }

  get pending(): string {
    return this.buffer.toString("utf8");
  }
}

