using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MastercamMcp.Protocol
{
    /// <summary>Envelope for every request arriving over the bridge (audit ARCH-04).</summary>
    public sealed class BridgeRequest
    {
        public const int CurrentProtocolVersion = 2;
        public const int MinSupportedProtocolVersion = 2;

        public int ProtocolVersion { get; set; }
        public string RequestId { get; set; }
        public string Tool { get; set; }
        public JsonElement? Arguments { get; set; }
        public string Deadline { get; set; }
        public string IdempotencyKey { get; set; }
    }

    /// <summary>A cancellation message for an in-flight request (audit IPC-03).</summary>
    public sealed class BridgeCancel
    {
        public string RequestId { get; set; }
    }

    /// <summary>Typed error envelope (audit section 31).</summary>
    public sealed class BridgeError
    {
        public string Code { get; set; }
        public string Message { get; set; }
        public bool? Retryable { get; set; }
    }

    /// <summary>Envelope for every response sent back over the bridge.</summary>
    public sealed class BridgeResponse
    {
        public int ProtocolVersion { get; set; }
        public string RequestId { get; set; }
        public bool Ok { get; set; }
        public string Tool { get; set; }
        public object Data { get; set; }
        public BridgeError Error { get; set; }
        public object Receipt { get; set; }
        public bool? Live { get; set; }
        public string MastercamVersion { get; set; }
        public string AdapterVersion { get; set; }
        public string DocumentRevision { get; set; }
        public double? DurationMs { get; set; }
    }

    /// <summary>Result of parsing one inbound frame.</summary>
    public sealed class ParsedFrame
    {
        public string Kind { get; set; } // "request" | "cancel" | "invalid"
        public BridgeRequest Request { get; set; }
        public BridgeCancel Cancel { get; set; }
        public string InvalidReason { get; set; }
    }

    public static class BridgeEnvelope
    {
        public const int MaxRequestBytes = 1024 * 1024;       // audit IPC-01
        public const int MaxResponseBytes = 4 * 1024 * 1024;  // audit IPC-02

        private static readonly JsonSerializerOptions SerializerOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        /// <summary>
        /// Parses one newline-delimited frame. The wire format is flat and matches
        /// the TypeScript bridge client exactly:
        ///   {"type":"request","protocolVersion":2,"requestId":"...","tool":"...","arguments":{...}}
        ///   {"type":"cancel","requestId":"..."}
        /// A missing "type" is treated as a request for leniency with simple probes.
        /// The caller enforces MaxRequestBytes BEFORE calling this (IPC-01).
        /// </summary>
        public static ParsedFrame Parse(string frame)
        {
            if (string.IsNullOrWhiteSpace(frame))
                return Invalid("empty frame");

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(frame);
            }
            catch (JsonException ex)
            {
                return Invalid("invalid JSON: " + ex.Message);
            }

            using (document)
            {
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                    return Invalid("a JSON object is required");

                string type = null;
                JsonElement typeElement;
                if (document.RootElement.TryGetProperty("type", out typeElement) && typeElement.ValueKind == JsonValueKind.String)
                    type = typeElement.GetString();

                if (string.Equals(type, "cancel", StringComparison.OrdinalIgnoreCase))
                {
                    BridgeCancel cancel;
                    try
                    {
                        cancel = JsonSerializer.Deserialize<BridgeCancel>(document.RootElement.GetRawText(), SerializerOptions);
                    }
                    catch (JsonException ex)
                    {
                        return Invalid("invalid cancel frame: " + ex.Message);
                    }
                    if (cancel == null || string.IsNullOrEmpty(cancel.RequestId))
                        return Invalid("cancel frame is missing requestId");
                    return new ParsedFrame { Kind = "cancel", Cancel = cancel };
                }

                BridgeRequest request;
                try
                {
                    request = JsonSerializer.Deserialize<BridgeRequest>(document.RootElement.GetRawText(), SerializerOptions);
                }
                catch (JsonException ex)
                {
                    return Invalid("invalid request frame: " + ex.Message);
                }
                if (request == null)
                    return Invalid("frame parsed to null");
                if (request.ProtocolVersion < BridgeRequest.MinSupportedProtocolVersion)
                    return Invalid("unsupported protocol version " + request.ProtocolVersion);
                if (string.IsNullOrEmpty(request.RequestId))
                    return Invalid("missing requestId");
                if (string.IsNullOrEmpty(request.Tool))
                    return Invalid("missing tool");
                return new ParsedFrame { Kind = "request", Request = request };
            }
        }

        public static string SerializeResponse(BridgeResponse response)
        {
            return JsonSerializer.Serialize(response, SerializerOptions);
        }

        public static BridgeResponse ErrorResponse(string requestId, string tool, string code, string message, bool retryable = false)
        {
            return new BridgeResponse
            {
                ProtocolVersion = BridgeRequest.CurrentProtocolVersion,
                RequestId = requestId,
                Ok = false,
                Tool = tool,
                Error = new BridgeError { Code = code, Message = message, Retryable = retryable }
            };
        }

        public static string ErrorEnvelope(string requestId, string tool, string code, string message, bool retryable = false)
        {
            return SerializeResponse(ErrorResponse(requestId, tool, code, message, retryable));
        }

        private static ParsedFrame Invalid(string reason)
        {
            return new ParsedFrame { Kind = "invalid", InvalidReason = reason };
        }
    }
}
