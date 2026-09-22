using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.Core;
using MastercamMcp.Protocol;
using Xunit;

namespace MastercamMcp.Protocol.Tests
{
    public sealed class RouterQueueTests
    {
        [Fact]
        public async Task QueueCapacityRejectsExcessCommandsWithRetryableFailure()
        {
            var adapter = new BlockingAdapter();
            using var router = new RequestRouter(adapter, "test", maxQueuedCommands: 1);

            var first = router.Handle(Frame("queue-1"));
            Assert.NotNull(first.Pending);
            Assert.True(adapter.Started.Wait(TimeSpan.FromSeconds(2)), "first command did not reach the adapter");

            var second = router.Handle(Frame("queue-2"));
            Assert.NotNull(second.Pending);

            var third = router.Handle(Frame("queue-3"));
            Assert.NotNull(third.ImmediateResponse);
            Assert.Null(third.Pending);

            var response = JsonSerializer.Deserialize<BridgeResponse>(
                third.ImmediateResponse,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            Assert.NotNull(response);
            Assert.False(response.Ok);
            Assert.Equal("queue-3", response.RequestId);
            Assert.Equal(ErrorCodes.BackendUnavailable, response.Error.Code);
            Assert.True(response.Error.Retryable);
            Assert.Contains("queue is full", response.Error.Message, StringComparison.OrdinalIgnoreCase);

            adapter.Release.Set();
            Assert.True((await first.Pending.ConfigureAwait(false)).Ok);
            Assert.True((await second.Pending.ConfigureAwait(false)).Ok);
        }

        [Fact]
        public void QueueCapacityMustBePositive()
        {
            var adapter = new BlockingAdapter();
            Assert.Throws<ArgumentOutOfRangeException>(() => new RequestRouter(adapter, "test", maxQueuedCommands: 0));
        }

        private static string Frame(string requestId)
        {
            return JsonSerializer.Serialize(new
            {
                type = "request",
                protocolVersion = BridgeRequest.CurrentProtocolVersion,
                requestId,
                tool = "mastercam_status",
                arguments = new { }
            });
        }

        private sealed class BlockingAdapter : IMastercamAdapter
        {
            public ManualResetEventSlim Started { get; } = new ManualResetEventSlim(false);
            public ManualResetEventSlim Release { get; } = new ManualResetEventSlim(false);

            public AdapterInfo Info { get; } = new AdapterInfo
            {
                AdapterVersion = "queue-test",
                MastercamVersion = "test",
                Runtime = "test",
                ProtocolVersion = BridgeRequest.CurrentProtocolVersion
            };

            public IReadOnlyList<Capability> Capabilities()
            {
                return new[]
                {
                    new Capability
                    {
                        Name = "mastercam_status",
                        Supported = true,
                        RiskClass = RiskClass.Read,
                        Tier = CapabilityTier.Implemented,
                        MappingVersion = 1
                    }
                };
            }

            public AdapterResult Invoke(
                string tool,
                string argumentsJson,
                string requestId,
                CancellationToken cancellationToken)
            {
                Started.Set();
                Release.Wait(cancellationToken);
                return AdapterResult.Success(new { connected = true });
            }
        }
    }
}
