using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.Core;
using MastercamMcp.Protocol;
using Xunit;

namespace MastercamMcp.Protocol.Tests
{
    public class StubAdapter : IMastercamAdapter
    {
        public int MutationInvocations { get; private set; }
        public AdapterInfo Info => new AdapterInfo
        {
            AdapterVersion = "stub-1.0",
            MastercamVersion = "2026",
            Runtime = "test",
            ProtocolVersion = BridgeRequest.CurrentProtocolVersion
        };

        public IReadOnlyList<Capability> Capabilities()
        {
            return new List<Capability>
            {
                new Capability { Name = "mastercam_status", Supported = true, RiskClass = RiskClass.Read, Tier = CapabilityTier.LiveReadVerified, MappingVersion = 1 },
                new Capability { Name = "list_operations", Supported = true, RiskClass = RiskClass.Read, Tier = CapabilityTier.Implemented, MappingVersion = 1 },
                new Capability { Name = "regenerate_toolpath", Supported = true, RiskClass = RiskClass.Mutation, Tier = CapabilityTier.Implemented, MappingVersion = 1 },
                new Capability { Name = "change_tool", Supported = false, RiskClass = RiskClass.Mutation, Tier = CapabilityTier.Unavailable, Reason = "not_live_verified", MappingVersion = 0 }
            };
        }

        public AdapterResult Invoke(string tool, string argumentsJson, string requestId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (tool == "mastercam_status")
                return AdapterResult.Success(new { connected = true, backend = "stub" });
            if (tool == "list_operations")
                return AdapterResult.Success(new[] { new { id = 1, name = "op" } });
            if (tool == "regenerate_toolpath")
            {
                MutationInvocations++;
                return AdapterResult.Success(new { regenerated = true });
            }
            return AdapterResult.Failure("UNSUPPORTED_CAPABILITY", "stub has no mapping");
        }
    }

    public class RouterTests
    {
        private static RequestRouter NewRouter() => new RequestRouter(new StubAdapter(), "2026");

        [Fact]
        public async Task ValidRequestExecutes()
        {
            using var router = NewRouter();
            var outcome = router.Handle("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"r1\",\"tool\":\"mastercam_status\",\"arguments\":{}}");
            Assert.Null(outcome.ImmediateResponse);
            Assert.NotNull(outcome.Pending);
            var response = await outcome.Pending;
            Assert.True(response.Ok);
            Assert.Equal("r1", response.RequestId);
            Assert.Equal("mastercam_status", response.Tool);
        }

        [Fact]
        public void InvalidJsonIsRejected()
        {
            using var router = NewRouter();
            var response = router.HandleFrame("{not json");
            Assert.Contains("INVALID_JSON", response);
        }

        [Fact]
        public void MissingRequestIdIsRejected()
        {
            using var router = NewRouter();
            var response = router.HandleFrame("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"\",\"tool\":\"mastercam_status\"}");
            Assert.Contains("INVALID_REQUEST", response);
        }

        [Fact]
        public void UnknownProtocolVersionIsRejected()
        {
            using var router = NewRouter();
            var response = router.HandleFrame("{\"type\":\"request\",\"protocolVersion\":1,\"requestId\":\"r\",\"tool\":\"mastercam_status\"}");
            Assert.Contains("INVALID_REQUEST", response);
            Assert.Contains("protocol version", response);
        }

        [Fact]
        public void CancelFramesAreAcceptedSilently()
        {
            using var router = NewRouter();
            var outcome = router.Handle("{\"type\":\"cancel\",\"requestId\":\"nope\"}");
            Assert.True(outcome.IsCancel);
            Assert.Null(outcome.ImmediateResponse);
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
            var giant = "{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"r\",\"tool\":\"x\",\"arguments\":\"" +
                        new string('x', FrameConstants.MaxRequestMetadataSize) + "\"}";
            var response = router.HandleFrame(giant);
            Assert.Contains("REQUEST_TOO_LARGE", response);
        }

        [Fact]
        public void RegistryRespectsVerificationTiers()
        {
            using var router = NewRouter();
            Assert.NotNull(router.Registry.Find("mastercam_status"));
            Assert.True(router.Registry.Find("mastercam_status").Supported);
            Assert.False(router.Registry.Find("change_tool").Supported);
            Assert.Null(router.Registry.Find("unknown_tool"));
            Assert.Equal(3, router.Registry.SupportedCount);
            Assert.Equal(1, router.Registry.UnsupportedCount);
        }

        [Fact]
        public async Task MutationIdempotencyReplaysWithoutReinvokingAdapter()
        {
            var adapter = new StubAdapter();
            using var router = new RequestRouter(adapter, "2026");

            var first = router.Handle("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"m1\",\"tool\":\"regenerate_toolpath\",\"idempotencyKey\":\"idem-12345678\",\"arguments\":{\"operationIds\":[1]}}");
            var firstResponse = await first.Pending;
            Assert.True(firstResponse.Ok);

            var replay = router.Handle("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"m2\",\"tool\":\"regenerate_toolpath\",\"idempotencyKey\":\"idem-12345678\",\"arguments\":{\"operationIds\":[1]}}");
            var replayResponse = await replay.Pending;

            Assert.True(replayResponse.Ok);
            Assert.Equal("m2", replayResponse.RequestId);
            Assert.Equal(1, adapter.MutationInvocations);
        }

        [Fact]
        public async Task IdempotencyKeyCannotBeReusedForDifferentMutation()
        {
            var adapter = new StubAdapter();
            using var router = new RequestRouter(adapter, "2026");

            var first = router.Handle("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"m3\",\"tool\":\"regenerate_toolpath\",\"idempotencyKey\":\"idem-conflict\",\"arguments\":{\"operationIds\":[1]}}");
            await first.Pending;

            var conflict = router.Handle("{\"type\":\"request\",\"protocolVersion\":2,\"requestId\":\"m4\",\"tool\":\"regenerate_toolpath\",\"idempotencyKey\":\"idem-conflict\",\"arguments\":{\"operationIds\":[2]}}");
            Assert.NotNull(conflict.ImmediateResponse);
            Assert.Contains("IDEMPOTENCY_CONFLICT", conflict.ImmediateResponse);
            Assert.Equal(1, adapter.MutationInvocations);
        }
    }
}
