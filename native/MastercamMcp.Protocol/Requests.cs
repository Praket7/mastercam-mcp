using System;
using System.Text.Json.Serialization;

namespace MastercamMcp.Protocol
{
    public enum ProtocolVersion { V1 = 1, V2 = 2 }
    public enum RequestType { Request, Cancel, Ping }
    public enum ResponseType { Response, Event, Error }

    public sealed class BridgeRequest
    {
        public const int CurrentProtocolVersion = 2;

        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; set; } = CurrentProtocolVersion;

        [JsonPropertyName("requestId")]
        public string RequestId { get; set; } = string.Empty;

        [JsonPropertyName("type")]
        public RequestType Type { get; set; } = RequestType.Request;

        [JsonPropertyName("tool")]
        public string Tool { get; set; } = string.Empty;

        [JsonPropertyName("arguments")]
        public System.Text.Json.Nodes.JsonObject? Arguments { get; set; }

        [JsonPropertyName("deadline")]
        public string? Deadline { get; set; }

        [JsonPropertyName("idempotencyKey")]
        public string? IdempotencyKey { get; set; }

        [JsonPropertyName("priority")]
        public int Priority { get; set; }
    }

    public sealed class BridgeResponse
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; set; } = BridgeRequest.CurrentProtocolVersion;

        [JsonPropertyName("requestId")]
        public string RequestId { get; set; } = string.Empty;

        [JsonPropertyName("type")]
        public ResponseType Type { get; set; } = ResponseType.Response;

        [JsonPropertyName("result")]
        public object? Result { get; set; }

        [JsonPropertyName("error")]
        public BridgeError? Error { get; set; }

        [JsonPropertyName("executionDurationMs")]
        public long? ExecutionDurationMs { get; set; }

        [JsonPropertyName("adapterVersion")]
        public string? AdapterVersion { get; set; }

        [JsonPropertyName("mastercamVersion")]
        public string? MastercamVersion { get; set; }

        [JsonPropertyName("documentRevision")]
        public string? DocumentRevision { get; set; }

        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("tool")]
        public string? Tool { get; set; }

        [JsonPropertyName("data")]
        public object? Data { get; set; }

        [JsonPropertyName("receipt")]
        public object? Receipt { get; set; }

        [JsonPropertyName("live")]
        public bool Live { get; set; }

        [JsonPropertyName("durationMs")]
        public double DurationMs { get; set; }
    }

    public sealed class BridgeEvent
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; set; } = BridgeRequest.CurrentProtocolVersion;

        [JsonPropertyName("eventId")]
        public string EventId { get; set; } = Guid.NewGuid().ToString();

        [JsonPropertyName("event")]
        public string EventType { get; set; } = string.Empty;

        [JsonPropertyName("timestamp")]
        public string Timestamp { get; set; } = DateTime.UtcNow.ToString("O");

        [JsonPropertyName("data")]
        public object? Data { get; set; }
    }

    public sealed class BridgeError
    {
        [JsonPropertyName("code")]
        public string Code { get; set; } = string.Empty;

        [JsonPropertyName("message")]
        public string Message { get; set; } = string.Empty;

        [JsonPropertyName("retryable")]
        public bool Retryable { get; set; }

        [JsonPropertyName("remediation")]
        public string? Remediation { get; set; }
    }

    public static class ErrorCodes
    {
        public const string BackendUnavailable = "BACKEND_UNAVAILABLE";
        public const string Timeout = "TIMEOUT";
        public const string Cancelled = "CANCELLED";
        public const string OperationNotFound = "OPERATION_NOT_FOUND";
        public const string AmbiguousTarget = "AMBIGUOUS_TARGET";
        public const string StalePreview = "STALE_PREVIEW";
        public const string CapabilityUnavailable = "CAPABILITY_UNAVAILABLE";
        public const string MastercamApiError = "MASTERCAM_API_ERROR";
        public const string ValidationFailed = "VALIDATION_FAILED";
        public const string RegenerationFailed = "REGENERATION_FAILED";
        public const string SimulationFailed = "SIMULATION_FAILED";
        public const string InvalidJson = "INVALID_JSON";
        public const string InvalidRequest = "INVALID_REQUEST";
        public const string RequestTooLarge = "REQUEST_TOO_LARGE";
        public const string ResponseTooLarge = "RESPONSE_TOO_LARGE";
        public const string UnsupportedTool = "UNSUPPORTED_TOOL";
        public const string UnsupportedCapability = "UNSUPPORTED_CAPABILITY";
        public const string InvalidApprovalToken = "INVALID_APPROVAL_TOKEN";
        public const string ApprovalTokenUsed = "APPROVAL_TOKEN_USED";
        public const string ApprovalTokenExpired = "APPROVAL_TOKEN_EXPIRED";
        public const string TransactionNotFound = "TRANSACTION_NOT_FOUND";
        public const string StaleState = "STALE_STATE";
        public const string ProfileDenied = "PROFILE_DENIED";
        public const string ConfirmationRequired = "CONFIRMATION_REQUIRED";
        public const string ApprovalTokenRequired = "APPROVAL_TOKEN_REQUIRED";
    }
}
