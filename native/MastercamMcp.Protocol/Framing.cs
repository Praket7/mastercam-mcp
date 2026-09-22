using System;
using System.Buffers;
using System.Buffers.Binary;
using System.Text;
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

    /// <summary>
    /// Reusable pooled accumulator for stream transports. It avoids the previous
    /// byte-at-a-time List growth, whole-buffer ToArray snapshots, and RemoveRange
    /// shifts. A completed frame is decoded directly from the pooled buffer.
    /// </summary>
    public sealed class PooledFrameBuffer : IDisposable
    {
        private byte[] buffer;
        private int start;
        private int end;
        private bool disposed;

        public PooledFrameBuffer(int initialCapacity = 32 * 1024)
        {
            if (initialCapacity < FrameConstants.FrameHeaderSize) initialCapacity = FrameConstants.FrameHeaderSize;
            buffer = ArrayPool<byte>.Shared.Rent(initialCapacity);
        }

        public int BufferedBytes => end - start;

        public void Append(byte[] source, int offset, int count)
        {
            if (disposed) throw new ObjectDisposedException(nameof(PooledFrameBuffer));
            if (source == null) throw new ArgumentNullException(nameof(source));
            if (offset < 0 || count < 0 || offset + count > source.Length) throw new ArgumentOutOfRangeException();
            if (count == 0) return;
            EnsureWritable(count);
            Buffer.BlockCopy(source, offset, buffer, end, count);
            end += count;
        }

        public bool TryReadUtf8Frame(out string frame)
        {
            if (disposed) throw new ObjectDisposedException(nameof(PooledFrameBuffer));
            frame = null;
            if (BufferedBytes < FrameConstants.FrameHeaderSize) return false;

            var length = BinaryPrimitives.ReadInt64LittleEndian(
                new ReadOnlySpan<byte>(buffer, start, FrameConstants.FrameHeaderSize));
            if (length < 0 || length > FrameConstants.MaxFrameSize)
                throw new InvalidOperationException($"Invalid frame length: {length}");

            var total = FrameConstants.FrameHeaderSize + (int)length;
            if (BufferedBytes < total) return false;

            frame = Encoding.UTF8.GetString(buffer, start + FrameConstants.FrameHeaderSize, (int)length);
            start += total;
            CompactIfUseful();
            return true;
        }

        private void EnsureWritable(int count)
        {
            if (buffer.Length - end >= count) return;
            if (start > 0)
            {
                var available = end - start;
                Buffer.BlockCopy(buffer, start, buffer, 0, available);
                start = 0;
                end = available;
                if (buffer.Length - end >= count) return;
            }

            var required = checked(end + count);
            var nextSize = buffer.Length;
            while (nextSize < required)
            {
                nextSize = checked(nextSize * 2);
                if (nextSize > FrameConstants.MaxFrameSize + FrameConstants.FrameHeaderSize)
                {
                    nextSize = FrameConstants.MaxFrameSize + FrameConstants.FrameHeaderSize;
                    break;
                }
            }
            if (nextSize < required)
                throw new InvalidOperationException($"Buffered frame exceeds {FrameConstants.MaxFrameSize} bytes");

            var next = ArrayPool<byte>.Shared.Rent(nextSize);
            Buffer.BlockCopy(buffer, start, next, 0, end - start);
            end -= start;
            start = 0;
            ArrayPool<byte>.Shared.Return(buffer);
            buffer = next;
        }

        private void CompactIfUseful()
        {
            if (start == end)
            {
                start = 0;
                end = 0;
                return;
            }
            if (start < buffer.Length / 2) return;
            var remaining = end - start;
            Buffer.BlockCopy(buffer, start, buffer, 0, remaining);
            start = 0;
            end = remaining;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            var rented = buffer;
            buffer = Array.Empty<byte>();
            start = 0;
            end = 0;
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    public static class FrameSerializer
    {
        private static readonly JsonSerializerOptions Options = CreateOptions();

        public static byte[] Serialize<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);
        public static T? Deserialize<T>(ReadOnlySpan<byte> data) => JsonSerializer.Deserialize<T>(data, Options);
        public static T? Deserialize<T>(byte[] data) => JsonSerializer.Deserialize<T>(data, Options);

        private static JsonSerializerOptions CreateOptions()
        {
            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                PropertyNameCaseInsensitive = true,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
                WriteIndented = false
            };
            options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
            return options;
        }
    }
}
