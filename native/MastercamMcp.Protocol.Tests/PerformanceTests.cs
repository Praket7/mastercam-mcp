using System;
using System.Text;
using MastercamMcp.Protocol;
using Xunit;

namespace MastercamMcp.Protocol.Tests
{
    public sealed class PerformanceTests
    {
        [Fact]
        public void PooledFrameBuffer_DecodesOneByteChunks()
        {
            var json = "{\"message\":\"" + new string('x', 4096) + "\"}";
            var frame = FrameCodec.EncodeFrame(Encoding.UTF8.GetBytes(json));
            using var reader = new PooledFrameBuffer(16);

            for (var index = 0; index < frame.Length; index++)
            {
                reader.Append(frame, index, 1);
            }

            Assert.True(reader.TryReadUtf8Frame(out var decoded));
            Assert.Equal(json, decoded);
            Assert.Equal(0, reader.BufferedBytes);
        }

        [Fact]
        public void PooledFrameBuffer_DecodesBackToBackFrames()
        {
            var first = FrameCodec.EncodeFrame(Encoding.UTF8.GetBytes("one"));
            var second = FrameCodec.EncodeFrame(Encoding.UTF8.GetBytes("two"));
            var wire = new byte[first.Length + second.Length];
            Buffer.BlockCopy(first, 0, wire, 0, first.Length);
            Buffer.BlockCopy(second, 0, wire, first.Length, second.Length);

            using var reader = new PooledFrameBuffer(16);
            reader.Append(wire, 0, wire.Length);

            Assert.True(reader.TryReadUtf8Frame(out var one));
            Assert.True(reader.TryReadUtf8Frame(out var two));
            Assert.False(reader.TryReadUtf8Frame(out _));
            Assert.Equal("one", one);
            Assert.Equal("two", two);
        }

        [Fact]
        public void PooledFrameBuffer_RejectsOversizedFrame()
        {
            var header = new byte[FrameConstants.FrameHeaderSize];
            System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(
                header,
                (long)FrameConstants.MaxFrameSize + 1);
            using var reader = new PooledFrameBuffer(16);
            reader.Append(header, 0, header.Length);
            Assert.Throws<InvalidOperationException>(() => reader.TryReadUtf8Frame(out _));
        }
    }
}
