using System;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.Protocol;

namespace MastercamMcp.Core
{
    /// <summary>What the router decided to do with one inbound frame.</summary>
    public sealed class HandleOutcome
    {
        public string ImmediateResponse { get; set; }
        public Task<BridgeResponse> Pending { get; set; }
        public bool IsCancel { get; set; }

        public static HandleOutcome Immediate(string responseFrame)
        {
            return new HandleOutcome { ImmediateResponse = responseFrame };
        }
    }

    /// <summary>
    /// Parses bridge-v2 request/cancel envelopes and serializes all adapter execution
    /// through one worker thread. Transport reading remains independent so cancel
    /// frames can be processed while a command is in flight.
    /// </summary>
    public sealed class RequestRouter : IDisposable
    {
        private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();
        private readonly IMastercamAdapter adapter;
        private readonly BlockingCollection<Command> queue;
        private readonly Thread worker;
        private readonly ConcurrentDictionary<string, Command> inFlight;
        private readonly CapabilityRegistry registry;
        private readonly string mastercamVersion;

        public RequestRouter(IMastercamAdapter adapter, string mastercamVersion)
        {
            this.adapter = adapter ?? throw new ArgumentNullException(nameof(adapter));
            this.mastercamVersion = mastercamVersion ?? "unknown";
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

        public CapabilityRegistry Registry => this.registry;
        public string MastercamVersion => this.mastercamVersion;

        public HandleOutcome Handle(string frame)
        {
            frame ??= string.Empty;
            if (Encoding.UTF8.GetByteCount(frame) > FrameConstants.MaxRequestMetadataSize)
            {
                return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                    null, null, ErrorCodes.RequestTooLarge,
                    $"Request exceeds the {FrameConstants.MaxRequestMetadataSize} byte bridge metadata limit")));
            }

            try
            {
                using var document = JsonDocument.Parse(frame);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        null, null, ErrorCodes.InvalidRequest, "Bridge frame must be a JSON object")));
                }

                var kind = "request";
                if (root.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String)
                {
                    kind = typeElement.GetString() ?? "request";
                }

                if (string.Equals(kind, "cancel", StringComparison.OrdinalIgnoreCase))
                {
                    if (!root.TryGetProperty("requestId", out var idElement) ||
                        idElement.ValueKind != JsonValueKind.String ||
                        string.IsNullOrWhiteSpace(idElement.GetString()))
                    {
                        return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                            null, null, ErrorCodes.InvalidRequest, "Cancel frame requires requestId")));
                    }

                    Cancel(idElement.GetString());
                    return new HandleOutcome { IsCancel = true };
                }

                if (!string.Equals(kind, "request", StringComparison.OrdinalIgnoreCase))
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        null, null, ErrorCodes.InvalidRequest, $"Unsupported bridge frame type '{kind}'")));
                }

                BridgeRequest request;
                try
                {
                    request = JsonSerializer.Deserialize<BridgeRequest>(frame, JsonOptions);
                }
                catch (JsonException ex)
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        null, null, ErrorCodes.InvalidJson, ex.Message)));
                }

                if (request == null)
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        null, null, ErrorCodes.InvalidRequest, "Request body was empty")));
                }
                if (request.ProtocolVersion != BridgeRequest.CurrentProtocolVersion)
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        request.RequestId, request.Tool, ErrorCodes.InvalidRequest,
                        $"Unsupported bridge protocol version {request.ProtocolVersion}; expected {BridgeRequest.CurrentProtocolVersion}")));
                }
                if (string.IsNullOrWhiteSpace(request.RequestId))
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        null, request.Tool, ErrorCodes.InvalidRequest, "Request requires requestId")));
                }
                if (string.IsNullOrWhiteSpace(request.Tool))
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        request.RequestId, null, ErrorCodes.InvalidRequest, "Request requires tool")));
                }
                if (DeadlineExpired(request))
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        request.RequestId, request.Tool, ErrorCodes.Timeout, "Request deadline already expired", true)));
                }

                var capability = this.registry.Find(request.Tool);
                if (capability == null || !capability.Supported)
                {
                    return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                        request.RequestId, request.Tool, ErrorCodes.UnsupportedCapability,
                        "This live Mastercam tool has no verified mapping on the installed release")));
                }

                var command = new Command(request, this.registry.IsRead(request.Tool), this);
                this.inFlight[request.RequestId] = command;
                this.queue.Add(command);
                return new HandleOutcome { Pending = AwaitCompletion(command) };
            }
            catch (JsonException ex)
            {
                return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                    null, null, ErrorCodes.InvalidJson, ex.Message)));
            }
            catch (Exception ex)
            {
                return HandleOutcome.Immediate(SerializeResponse(ErrorResponse(
                    null, null, ErrorCodes.InvalidRequest, ex.Message)));
            }
        }

        public string HandleFrame(string frame)
        {
            var outcome = Handle(frame);
            return outcome.ImmediateResponse;
        }

        public void Cancel(string requestId)
        {
            if (string.IsNullOrEmpty(requestId)) return;
            if (this.inFlight.TryGetValue(requestId, out var command)) command.Cancel();
        }

        public void CancelAll()
        {
            foreach (var command in this.inFlight.Values) command.Cancel();
        }

        public void Dispose()
        {
            this.queue.CompleteAdding();
            CancelAll();
            try { this.worker.Join(1500); } catch { }
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
                command.Router.inFlight.TryRemove(command.Request.RequestId, out _);
                command.Source.Dispose();
            }
        }

        private sealed class Command
        {
            public Command(BridgeRequest request, bool isRead, RequestRouter router)
            {
                Request = request;
                Source = new CancellationTokenSource();
                IsRead = isRead;
                Router = router;
                Completion = new TaskCompletionSource<BridgeResponse>(TaskCreationOptions.RunContinuationsAsynchronously);

                if (!string.IsNullOrWhiteSpace(request.Deadline) &&
                    DateTimeOffset.TryParse(request.Deadline, out var deadline))
                {
                    var delay = deadline.UtcDateTime - DateTime.UtcNow;
                    if (delay <= TimeSpan.Zero) Source.Cancel();
                    else Source.CancelAfter(delay);
                }
            }

            public BridgeRequest Request { get; }
            public CancellationTokenSource Source { get; }
            public bool IsRead { get; }
            public RequestRouter Router { get; }
            public TaskCompletionSource<BridgeResponse> Completion { get; }

            public void Cancel()
            {
                try { Source.Cancel(); } catch { }
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
                command.Source.Token.ThrowIfCancellationRequested();
                var arguments = request.Arguments?.ToJsonString() ?? "{}";
                var result = this.adapter.Invoke(request.Tool, arguments, request.RequestId, command.Source.Token);
                if (result == null)
                {
                    return ErrorResponse(request.RequestId, request.Tool, ErrorCodes.MastercamApiError, "Adapter returned no result");
                }

                return new BridgeResponse
                {
                    ProtocolVersion = BridgeRequest.CurrentProtocolVersion,
                    RequestId = request.RequestId,
                    Type = ResponseType.Response,
                    Ok = result.Ok,
                    Tool = request.Tool,
                    Data = result.Ok ? result.Data : null,
                    Error = result.Ok ? null : new BridgeError
                    {
                        Code = result.ErrorCode ?? "ADAPTER_ERROR",
                        Message = result.ErrorMessage ?? string.Empty,
                        Retryable = result.Retryable
                    },
                    Receipt = result.Receipt,
                    Live = true,
                    MastercamVersion = this.mastercamVersion,
                    AdapterVersion = this.adapter.Info?.AdapterVersion,
                    DocumentRevision = result.DocumentRevision,
                    DurationMs = (DateTime.UtcNow - startedAt).TotalMilliseconds
                };
            }
            catch (OperationCanceledException)
            {
                var timeout = DeadlineExpired(request);
                return ErrorResponse(
                    request.RequestId,
                    request.Tool,
                    timeout ? ErrorCodes.Timeout : ErrorCodes.Cancelled,
                    timeout ? "Request deadline expired at a safe boundary" : "Request was cancelled at a safe boundary",
                    timeout);
            }
            catch (Exception ex)
            {
                return ErrorResponse(request.RequestId, request.Tool, ErrorCodes.MastercamApiError, ex.Message);
            }
        }

        private static bool DeadlineExpired(BridgeRequest request)
        {
            return !string.IsNullOrWhiteSpace(request?.Deadline) &&
                   DateTimeOffset.TryParse(request.Deadline, out var deadline) &&
                   deadline <= DateTimeOffset.UtcNow;
        }

        private static BridgeResponse ErrorResponse(
            string requestId,
            string tool,
            string code,
            string message,
            bool retryable = false)
        {
            return new BridgeResponse
            {
                ProtocolVersion = BridgeRequest.CurrentProtocolVersion,
                RequestId = requestId ?? string.Empty,
                Type = ResponseType.Error,
                Ok = false,
                Tool = tool,
                Error = new BridgeError { Code = code, Message = message, Retryable = retryable },
                Live = true
            };
        }

        private static string SerializeResponse(BridgeResponse response)
        {
            return JsonSerializer.Serialize(response, JsonOptions);
        }

        private static JsonSerializerOptions CreateJsonOptions()
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
