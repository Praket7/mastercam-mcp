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

            using (var document = JsonDocument.Parse(third.ImmediateResponse))
            {
                var root = document.RootElement;
                Assert.False(root.GetProperty("ok").GetBoolean());
                Assert.Equal("queue-3", root.GetProperty("requestId").GetString());
                var error = root.GetProperty("error");
                Assert.Equal(ErrorCodes.BackendUnavailable, error.GetProperty("code").GetString());
                Assert.True(error.GetProperty("retryable").GetBoolean());
                Assert.Contains("queue is full", error.GetProperty("message").GetString().ToLowerInvariant());
            }

            adapter.Release.Set();
            Assert.True((await first.Pending).Ok);
            Assert.True((await second.Pending).Ok);
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
