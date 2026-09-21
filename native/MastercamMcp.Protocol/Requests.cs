using System;
using System.Text.Json.Serialization;

namespace MastercamMcp.Protocol
{
    public enum ProtocolVersion { V1 = 1, V2 = 2 }

    public enum RequestType { Request, Cancel, Ping }

    public enum ResponseType { Response, Event, Error }

    public sealed class BridgeRequest
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; init; } = 2;

        [JsonPropertyName("requestId")]
        public string RequestId { get; init; } = string.Empty;

        [JsonPropertyName("type")]
        public RequestType Type { get; init; } = RequestType.Request;

        [JsonPropertyName("tool")]
        public string Tool { get; init; } = string.Empty;

        [JsonPropertyName("arguments")]
        public System.Text.Json.Nodes.JsonObject? Arguments { get; init; }

        [JsonPropertyName("deadline")]
        public string? Deadline { get; init; }

        [JsonPropertyName("idempotencyKey")]
        public string? IdempotencyKey { get; init; }

        [JsonPropertyName("priority")]
        public int Priority { get; init; } = 0;
    }

    public sealed class BridgeResponse
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; init; } = 2;

        [JsonPropertyName("requestId")]
        public string RequestId { get; init; } = string.Empty;

        [JsonPropertyName("type")]
        public ResponseType Type { get; init; } = ResponseType.Response;

        [JsonPropertyName("result")]
        public object? Result { get; init; }

        [JsonPropertyName("error")]
        public BridgeError? Error { get; init; }

        [JsonPropertyName("executionDurationMs")]
        public long? ExecutionDurationMs { get; init; }

        [JsonPropertyName("adapterVersion")]
        public string? AdapterVersion { get; init; }

        [JsonPropertyName("mastercamVersion")]
        public string? MastercamVersion { get; init; }

        [JsonPropertyName("documentRevision")]
        public string? DocumentRevision { get; init; }
    }

    public sealed class BridgeEvent
    {
        [JsonPropertyName("protocolVersion")]
        public int ProtocolVersion { get; init; } = 2;

        [JsonPropertyName("eventId")]
        public string EventId { get; init; } = Guid.NewGuid().ToString();

        [JsonPropertyName("event")]
        public string EventType { get; init; } = string.Empty;

        [JsonPropertyName("timestamp")]
        public string Timestamp { get; init; } = DateTime.UtcNow.ToString("O");

        [JsonPropertyName("data")]
        public object? Data { get; init; }
    }

    public sealed class BridgeError
    {
        [JsonPropertyName("code")]
        public string Code { get; init; } = string.Empty;

        [JsonPropertyName("message")]
        public string Message { get; init; } = string.Empty;

        [JsonPropertyName("retryable")]
        public bool Retryable { get; init; }

        [JsonPropertyName("remediation")]
        public string? Remediation { get; init; }
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