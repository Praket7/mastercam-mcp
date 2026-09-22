using System;
using System.Threading;
using System.Collections.Generic;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.Core;
using MastercamMcp.Protocol;
using Xunit;

namespace MastercamMcp.Protocol.Tests
{
    public class EnvelopeTests
    {
        [Fact]
        public void ValidRequestParses()
        {
            var frame = "{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"r1\",\"tool\":\"mastercam_status\"}";
            var parsed = BridgeEnvelope.Parse(frame);
            Assert.Equal("request", parsed.Kind);
            Assert.Equal("r1", parsed.Request.RequestId);
            Assert.Equal("mastercam_status", parsed.Request.Tool);
        }

        [Fact]
        public void InvalidJsonIsRejected()
        {
            var parsed = BridgeEnvelope.Parse("{not json");
            Assert.Equal("invalid", parsed.Kind);
        }

        [Fact]
        public void MissingRequestIdIsRejected()
        {
            var frame = "{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"\",\"tool\":\"x\"}";
            Assert.Equal("invalid", BridgeEnvelope.Parse(frame).Kind);
        }

        [Fact]
        public void UnknownProtocolVersionIsRejected()
        {
            var frame = "{\"type\":\"request\",\"protocolVersion\":1,\"requestId\":\"r\",\"tool\":\"x\"}";
            var parsed = BridgeEnvelope.Parse(frame);
            Assert.Equal("invalid", parsed.Kind);
            Assert.Contains("protocol version", parsed.InvalidReason);
        }

        [Fact]
        public void MissingToolIsRejected()
        {
            var frame = "{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"r\"}";
            Assert.Equal("invalid", BridgeEnvelope.Parse(frame).Kind);
        }

        [Fact]
        public void CancelFramesParse()
        {
            var frame = "{\"type\":\"cancel\",\"requestId\":\"r9\"}";
            var parsed = BridgeEnvelope.Parse(frame);
            Assert.Equal("cancel", parsed.Kind);
            Assert.Equal("r9", parsed.Cancel.RequestId);
        }

        [Fact]
        public void ErrorEnvelopeSerializes()
        {
            var json = BridgeEnvelope.ErrorEnvelope("r1", "t", "REQUEST_TOO_LARGE", "too big", false);
            Assert.Contains("\"ok\":false", json);
            Assert.Contains("REQUEST_TOO_LARGE", json);
        }
    }

    public class StubAdapter : IMastercamAdapter
    {
        public AdapterInfo Info => new AdapterInfo { AdapterVersion = "stub-1.0", MastercamVersion = "2026", Runtime = "test", ProtocolVersion = 2 };

        public IReadOnlyList<Capability> Capabilities()
        {
            return new List<Capability>
            {
                new Capability { Name = "mastercam_status", Supported = true, RiskClass = RiskClass.Read, Tier = CapabilityTier.LiveReadVerified, MappingVersion = 1 },
                new Capability { Name = "list_operations", Supported = true, RiskClass = RiskClass.Read, Tier = CapabilityTier.Implemented, MappingVersion = 1 },
                new Capability { Name = "set_feed_speed", Supported = false, RiskClass = RiskClass.Mutation, Tier = CapabilityTier.Unavailable, Reason = "not_live_verified", MappingVersion = 0 }
            };
        }

        public AdapterResult Invoke(string tool, string argumentsJson, string requestId, CancellationToken cancellationToken)
        {
            if (tool == "mastercam_status")
            {
                return AdapterResult.Success(new { connected = true, backend = "stub" });
            }
            if (tool == "slow_tool")
            {
                Thread.Sleep(200);
                return AdapterResult.Success(new { done = true });
            }
            if (tool == "throwing_tool")
            {
                throw new InvalidOperationException("boom");
            }
            return AdapterResult.Failure("UNSUPPORTED_CAPABILITY", "stub has no mapping");
        }
    }

    public class RouterTests
    {
        private static RequestRouter NewRouter()
        {
            return new RequestRouter(new StubAdapter(), "2026");
        }

        [Fact]
        public void RouterRejectsUnknownProtocolWithoutTouchingAdapter()
        {
            using var router = NewRouter();
            var response = router.HandleFrame("{\"type\":\"request\",\"protocolVersion\":1,\"requestId\":\"r\",\"tool\":\"mastercam_status\"}");
            Assert.Contains("INVALID_REQUEST", response);
        }

        [Fact]
        public void RouterRejectsUnsupportedToolWithTypedError()
        {
            using var router = NewRouter();
            var response = router.HandleFrame("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"r1\",\"tool\":\"no_such_tool\"}");
            Assert.Contains("UNSUPPORTED_CAPABILITY", response);
        }

        [Fact]
        public void RouterRejectsOversizedFramesBeforeParsing()
        {
            using var router = NewRouter();
            var giant = "{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"r\",\"tool\":\"x\",\"arguments\":" + new string(' ', BridgeEnvelope.MaxRequestBytes) + "}";
            var response = router.HandleFrame(giant);
            Assert.Contains("REQUEST_TOO_LARGE", response);
        }

        [Fact]
        public void RouterReturnsNullForCancelFrames()
        {
            using var router = NewRouter();
            Assert.Null(router.HandleFrame("{\"type\":\"cancel\",\"requestId\":\"nope\"}"));
        }

        [Fact]
        public void RegistryRespectsVerificationTiers()
        {
            using var router = NewRouter();
            Assert.NotNull(router.Registry.Find("mastercam_status"));
            Assert.True(router.Registry.Find("mastercam_status").Supported);
            Assert.False(router.Registry.Find("set_feed_speed").Supported);
            Assert.Null(router.Registry.Find("unknown_tool"));
            Assert.Equal(2, router.Registry.SupportedCount);
            Assert.Equal(1, router.Registry.UnsupportedCount);
        }
    }
}
