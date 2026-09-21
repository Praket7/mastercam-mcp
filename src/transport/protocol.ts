export const MAX_FRAME_SIZE = 16 * 1024 * 1024;

export function encodeFrame(payload: Buffer | Uint8Array): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(8 + buf.length);
  frame.writeBigUInt64LE(BigInt(buf.length), 0);
  buf.copy(frame, 8);
  return frame;
}

export function decodeFrame(frame: Buffer | Uint8Array): { payload: Buffer; remaining: Buffer } | null {
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buf.length < 8) return null;
  const len = Number(buf.readBigUInt64LE(0));
  if (len < 0 || len > MAX_FRAME_SIZE) throw new Error(`Invalid frame length: ${len}`);
  if (buf.length < 8 + len) return null;
  return {
    payload: buf.subarray(8, 8 + len),
    remaining: buf.subarray(8 + len)
  };
}

// Re-export for compatibility with older tests that import from framing
export const FrameConstants = { MaxFrameSize: MAX_FRAME_SIZE };
