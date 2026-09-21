using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.Protocol;

namespace MastercamMcp.Core
{
    /// <summary>What the router decided to do with one inbound frame.</summary>
    public sealed class HandleOutcome
    {
        /// <summary>Write this line immediately (errors, unsupported capability) and keep reading.</summary>
        public string ImmediateResponse { get; set; }

        /// <summary>Non-null for accepted requests: await, serialize, and write the correlated response.</summary>
        public Task<BridgeResponse> Pending { get; set; }

        /// <summary>True for cancel frames, which are acknowledged silently (no response line).</summary>
        public bool IsCancel { get; set; }

        public static HandleOutcome Immediate(string responseFrame)
        {
            return new HandleOutcome { ImmediateResponse = responseFrame };
        }
    }

    /// <summary>
    /// Routes parsed bridge frames to the active adapter through a single command
    /// queue. Transport concurrency is decoupled from Mastercam API execution
    /// concurrency: pipe listeners enqueue and await, one worker executes against
    /// Mastercam (audit SAFE-02/PERF-02). Cancels take effect only at safe
    /// boundaries; the worker always completes a command it accepted.
    /// </summary>
    public sealed class RequestRouter : IDisposable
    {
        private readonly IMastercamAdapter adapter;
        private readonly BlockingCollection<Command> queue;
        private readonly Thread worker;
        private readonly ConcurrentDictionary<string, Command> inFlight;
        private readonly CapabilityRegistry registry;
        private readonly string mastercamVersion;

        public RequestRouter(IMastercamAdapter adapter, string mastercamVersion)
        {
            this.adapter = adapter;
            this.mastercamVersion = mastercamVersion;
            this.registry = new CapabilityRegistry(adapter);
            this.queue = new BlockingCollection<Command>(new ConcurrentQueue<Command>());
            this.inFlight = new ConcurrentDictionary<string, Command>(StringComparer.Ordinal);
            this.worker = new Thread(ExecuteLoop)
            {
                IsBackground = true,
                Name = "Mastercam MCP command scheduler"
            };
            this.worker.Start();
        }

        public CapabilityRegistry Registry
        {
            get { return this.registry; }
        }

        public string MastercamVersion
        {
            get { return this.mastercamVersion; }
        }

        /// <summary>
        /// Handles one frame. Returns an immediate response for invalid frames,
        /// oversized frames, cancels, and unsupported tools; returns a pending
        /// execution for accepted requests. Never throws.
        /// </summary>
        public HandleOutcome Handle(string frame)
        {
            if (frame == null) frame = string.Empty;
            if (frame.Length > BridgeEnvelope.MaxRequestBytes)
            {
                return HandleOutcome.Immediate(BridgeEnvelope.ErrorEnvelope(null, null, "REQUEST_TOO_LARGE", "Request exceeds the 1 MiB bridge limit"));
            }
            var parsed = BridgeEnvelope.Parse(frame);
            if (parsed.Kind == "invalid")
            {
                return HandleOutcome.Immediate(BridgeEnvelope.ErrorEnvelope(null, null, "INVALID_REQUEST", parsed.InvalidReason ?? "unparseable frame"));
            }
            if (parsed.Kind == "cancel")
            {
                this.Cancel(parsed.Cancel.RequestId);
                return new HandleOutcome { IsCancel = true };
            }
            var request = parsed.Request;
            var capability = this.registry.Find(request.Tool);
            if (capability == null || !capability.Supported)
            {
                return HandleOutcome.Immediate(BridgeEnvelope.ErrorEnvelope(
                    request.RequestId,
                    request.Tool,
                    "UNSUPPORTED_CAPABILITY",
                    "This live Mastercam tool has no verified mapping on the installed release"));
            }
            var command = new Command(request, this.registry.IsRead(request.Tool), this);
            this.inFlight[request.RequestId] = command;
            this.queue.Add(command);
            return new HandleOutcome { Pending = AwaitCompletion(command) };
        }

        /// <summary>Convenience wrapper used by simple one-shot hosts: immediate responses come back as strings.</summary>
        public string HandleFrame(string frame)
        {
            var outcome = this.Handle(frame);
            return outcome.ImmediateResponse;
        }

        /// <summary>Cancels one in-flight request at the next safe boundary (audit IPC-03).</summary>
        public void Cancel(string requestId)
        {
            if (string.IsNullOrEmpty(requestId)) return;
            Command command;
            if (this.inFlight.TryGetValue(requestId, out command)) command.Cancel();
        }

        /// <summary>Cancels every in-flight request; called when a client connection drops.</summary>
        public void CancelAll()
        {
            foreach (var command in this.inFlight.Values) command.Cancel();
        }

        public void Dispose()
        {
            this.queue.CompleteAdding();
            this.CancelAll();
            try { this.worker.Join(1500); } catch { /* worker exit is best effort on shutdown */ }
            this.queue.Dispose();
        }

        private static async Task<BridgeResponse> AwaitCompletion(Command command)
        {
            try
            {
                return await command.Completion.Task.ConfigureAwait(false);
            }
            finally
            {
                Command removed;
                command.Router.inFlight.TryRemove(command.Request.RequestId, out removed);
            }
        }

        private sealed class Command
        {
            public Command(BridgeRequest request, bool isRead, RequestRouter router)
            {
                this.Request = request;
                this.Source = new CancellationTokenSource();
                this.IsRead = isRead;
                this.Router = router;
                this.Completion = new TaskCompletionSource<BridgeResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
            }

            public BridgeRequest Request { get; private set; }
            public CancellationTokenSource Source { get; private set; }
            public bool IsRead { get; private set; }
            public RequestRouter Router { get; private set; }
            public TaskCompletionSource<BridgeResponse> Completion { get; private set; }

            public void Cancel()
            {
                try { this.Source.Cancel(); } catch { /* already cancelled or disposed */ }
            }
        }

        private void ExecuteLoop()
        {
            foreach (var command in this.queue.GetConsumingEnumerable())
            {
                var response = Execute(command);
                command.Completion.TrySetResult(response);
            }
        }

        private BridgeResponse Execute(Command command)
        {
            var request = command.Request;
            var startedAt = DateTime.UtcNow;
            try
            {
                var arguments = request.Arguments.HasValue ? request.Arguments.Value.GetRawText() : "{}";
                var result = this.adapter.Invoke(request.Tool, arguments, request.RequestId, command.Source.Token);
                return new BridgeResponse
                {
                    ProtocolVersion = BridgeRequest.CurrentProtocolVersion,
                    RequestId = request.RequestId,
                    Ok = result.Ok,
                    Tool = request.Tool,
                    Data = result.Ok ? result.Data : null,
                    Error = result.Ok ? null : new BridgeError { Code = result.ErrorCode ?? "ADAPTER_ERROR", Message = result.ErrorMessage ?? string.Empty, Retryable = result.Retryable },
                    Receipt = result.Receipt,
                    Live = true,
                    MastercamVersion = this.mastercamVersion,
                    AdapterVersion = this.adapter.Info != null ? this.adapter.Info.AdapterVersion : null,
                    DocumentRevision = result.DocumentRevision,
                    DurationMs = (DateTime.UtcNow - startedAt).TotalMilliseconds
                };
            }
            catch (OperationCanceledException)
            {
                return BridgeEnvelope.ErrorResponse(request.RequestId, request.Tool, "CANCELLED", "Request was cancelled at a safe boundary");
            }
            catch (Exception ex)
            {
                return BridgeEnvelope.ErrorResponse(request.RequestId, request.Tool, "MASTERCAM_API_ERROR", ex.Message);
            }
        }
    }
}
