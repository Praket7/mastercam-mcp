using System;
using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MastercamMcp.Protocol
{
    public static class FrameConstants
    {
        public const int MaxFrameSize = 16 * 1024 * 1024;
        public const int MaxRequestMetadataSize = 1024 * 1024;
        public const int MaxResponseSize = 4 * 1024 * 1024;
        public const int FrameHeaderSize = 8;
    }

    public static class FrameCodec
    {
        public static byte[] EncodeFrame(ReadOnlySpan<byte> payload)
        {
            if (payload.Length > FrameConstants.MaxFrameSize)
                throw new ArgumentException($"Payload exceeds maximum frame size: {payload.Length}");
            var frame = new byte[FrameConstants.FrameHeaderSize + payload.Length];
            BinaryPrimitives.WriteInt64LittleEndian(frame.AsSpan(0, FrameConstants.FrameHeaderSize), payload.Length);
            payload.CopyTo(frame.AsSpan(FrameConstants.FrameHeaderSize));
            return frame;
        }

        public static bool TryDecodeFrame(ReadOnlySpan<byte> buffer, out ReadOnlyMemory<byte> payload, out int consumed)
        {
            payload = default;
            consumed = 0;
            if (buffer.Length < FrameConstants.FrameHeaderSize) return false;
            var length = BinaryPrimitives.ReadInt64LittleEndian(buffer.Slice(0, FrameConstants.FrameHeaderSize));
            if (length < 0 || length > FrameConstants.MaxFrameSize)
                throw new InvalidOperationException($"Invalid frame length: {length}");
            var total = FrameConstants.FrameHeaderSize + (int)length;
            if (buffer.Length < total) return false;
            payload = new ReadOnlyMemory<byte>(buffer.Slice(FrameConstants.FrameHeaderSize, (int)length).ToArray());
            consumed = total;
            return true;
        }
    }

    public static class FrameSerializer
    {
        private static readonly JsonSerializerOptions Options = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

        public static byte[] Serialize<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);

        public static T? Deserialize<T>(ReadOnlySpan<byte> data) => JsonSerializer.Deserialize<T>(data, Options);
        public static T? Deserialize<T>(byte[] data) => JsonSerializer.Deserialize<T>(data, Options);
    }
}
