export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Incremental newline-delimited frame reader.
 * Feeds arbitrary chunk sizes; emits complete frames only, and rejects
 * oversized frames before they can accumulate unbounded memory.
 */
export class FrameReader {
  private buffer = "";
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > this.maxFrameBytes) {
        throw new Error(`RESPONSE_TOO_LARGE: frame exceeded ${this.maxFrameBytes} bytes`);
      }
      frames.push(line);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new Error(`RESPONSE_TOO_LARGE: buffered data exceeded ${this.maxFrameBytes} bytes without a newline`);
    }
    return frames;
  }

  /** Unprocessed partial data (for diagnostics/tests). */
  get pending(): string {
    return this.buffer;
  }
}

export function encodeFrame(payload: string): string {
  if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(`REQUEST_TOO_LARGE: frame exceeded ${MAX_FRAME_BYTES} bytes`);
  }
  return `${payload}\n`;
}
