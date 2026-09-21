import { MAX_FRAME_SIZE } from "./protocol.js";
export const MAX_FRAME_BYTES = MAX_FRAME_SIZE;
// Legacy newline framing is deprecated; canonical is 8-byte in protocol.ts
export class FrameReader {
  private buffer = "";
  private readonly maxFrameBytes: number;
  constructor(maxFrameBytes = MAX_FRAME_BYTES) { this.maxFrameBytes = maxFrameBytes; }
  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > this.maxFrameBytes) throw new Error(`RESPONSE_TOO_LARGE: frame exceeded ${this.maxFrameBytes} bytes`);
      frames.push(line);
    }
    if (this.buffer.length > this.maxFrameBytes) throw new Error(`RESPONSE_TOO_LARGE: buffered data exceeded ${this.maxFrameBytes} bytes without a newline`);
    return frames;
  }
  get pending(): string { return this.buffer; }
}
