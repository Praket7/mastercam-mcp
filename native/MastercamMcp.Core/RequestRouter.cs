using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Protocol;
using MastercamMcp.Adapter.Abstractions;

namespace MastercamMcp.Core
{
    public sealed class RequestRouter
    {
        private readonly IMastercamAdapter _adapter;
        private readonly ConcurrentDictionary<string, TaskCompletionSource<BridgeResponse>> _pending = new();
        private readonly JsonSerializerOptions _jsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        public RequestRouter() : this(new LegacyAdapter()) { }

        public RequestRouter(IMastercamAdapter adapter)
        {
            _adapter = adapter;
        }

        public async Task<string> DispatchAsync(string json, CancellationToken ct = default)
        {
            var startTime = DateTime.UtcNow;
            BridgeRequest? request;
            try
            {
                request = JsonSerializer.Deserialize<BridgeRequest>(json, _jsonOptions);
            }
            catch (Exception ex)
            {
                return SerializeError(null, ErrorCodes.InvalidJson, ex.Message);
            }

            if (request == null)
                return SerializeError(null, ErrorCodes.InvalidRequest, "A JSON object is required");

            var response = new BridgeResponse
            {
                ProtocolVersion = 2,
                RequestId = request.RequestId,
                Type = ResponseType.Response,
                AdapterVersion = _adapter.AdapterVersion,
                MastercamVersion = _adapter.SupportedReleases.Length > 0 ? _adapter.SupportedReleases[0] : "unknown"
            };

            try
            {
                switch (request.Type)
                {
                    case RequestType.Ping:
                        response.Result = new { ok = true, pong = true };
                        break;

                    case RequestType.Cancel:
                        if (_pending.TryRemove(request.RequestId, out var tcs))
                        {
                            tcs.TrySetCanceled();
                        }
                        response.Result = new { ok = true, cancelled = true };
                        break;

                    case RequestType.Request:
                        response.Result = await DispatchToolAsync(request, ct);
                        break;

                    default:
                        response.Result = new { ok = false, error = new { code = ErrorCodes.UnsupportedTool, message = $"Unknown request type: {request.Type}" } };
                        break;
                }
            }
            catch (OperationCanceledException)
            {
                response.Result = new { ok = false, error = new { code = ErrorCodes.Cancelled, message = "Request cancelled" } };
            }
            catch (Exception ex)
            {
                response.Result = new { ok = false, error = new { code = ErrorCodes.MastercamApiError, message = ex.Message, retryable = false } };
            }
            finally
            {
                response.ExecutionDurationMs = (long)(DateTime.UtcNow - startTime).TotalMilliseconds;
            }

            return JsonSerializer.Serialize(response, _jsonOptions);
        }

        private async Task<object> DispatchToolAsync(BridgeRequest request, CancellationToken ct)
        {
            var tool = request.Tool;
            var args = request.Arguments ?? new();

            return tool switch
            {
                "mastercam_status" => new { ok = true, tool, live = true, data = new { connected = true, adapter = "NET Hook" } },
                "mastercam_capabilities" => new { ok = true, tool, live = true, data = _adapter.GetCapabilities() },

                "get_active_part" => await HandleGetActivePartAsync(ct),
                "list_operations" => await HandleListOperationsAsync(args, ct),
                "get_operation" => await HandleGetOperationAsync(args, ct),
                "find_operations" => await HandleFindOperationsAsync(args, ct),
                "get_stock" => await HandleGetStockAsync(ct),
                "get_wcs" => await HandleGetWcsAsync(ct),
                "list_machine_groups" => await HandleListMachineGroupsAsync(ct),
                "list_tools" => await HandleListToolsAsync(ct),
                "get_post_processor" => await HandleGetPostProcessorAsync(ct),
                "get_toolpath_status" => await HandleGetToolpathStatusAsync(args, ct),
                "get_operation_parameters" => await HandleGetOperationParametersAsync(args, ct),
                "preview_operation_parameters" => await HandlePreviewOperationParametersAsync(args, ct),
                "apply_operation_parameter_preview" => await HandleApplyOperationParameterPreviewAsync(args, ct),
                "verify_change" => await HandleVerifyChangeAsync(args, ct),
                "rollback_change" => await HandleRollbackChangeAsync(args, ct),
                "regenerate_toolpath" => await HandleRegenerateToolpathAsync(args, ct),
                "run_simulation" => await HandleRunSimulationAsync(args, ct),
                "detect_collisions" => await HandleDetectCollisionsAsync(args, ct),
                "estimate_cycle_time" => await HandleEstimateCycleTimeAsync(args, ct),
                "capture_view" => await HandleCaptureViewAsync(args, ct),
                "get_version_report" => await HandleGetVersionReportAsync(ct),
                "get_machine_context" => await HandleGetMachineContextAsync(ct),

                _ => new { ok = false, tool, live = false, error = new { code = ErrorCodes.UnsupportedCapability, message = "This live Mastercam tool has no verified NET Hook mapping yet" } }
            };
        }

        private Task<object> HandleGetActivePartAsync(CancellationToken ct)
        {
            return Task.FromResult<object>(_adapter.GetActivePartAsync(ct).Result ?? new { ok = false, error = new { code = ErrorCodes.BackendUnavailable, message = "No active document" } });
        }

        private async Task<object> HandleListOperationsAsync(JsonObject args, CancellationToken ct)
        {
            var includeDisabled = args.ContainsKey("includeDisabled") && args["includeDisabled"]?.GetValue<bool>() == true;
            var machineGroup = args.ContainsKey("machineGroup") ? args["machineGroup"]?.GetValue<string>() : null;
            var ops = await _adapter.ListOperationsAsync(includeDisabled, machineGroup, ct);
            return new { ok = true, tool = "list_operations", data = ops };
        }

        private async Task<object> HandleGetOperationAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationId", out var idNode) || idNode == null)
                return new { ok = false, tool = "get_operation", error = new { code = ErrorCodes.ValidationFailed, message = "operationId is required" } };
            var operationId = idNode.GetValue<int>();
            var op = await _adapter.GetOperationAsync(operationId, ct);
            return op != null ? new { ok = true, tool = "get_operation", data = op } : new { ok = false, tool = "get_operation", error = new { code = ErrorCodes.OperationNotFound, message = $"Operation {operationId} not found" } };
        }

        private async Task<object> HandleFindOperationsAsync(JsonObject args, CancellationToken ct)
        {
            var query = args.ContainsKey("query") ? args["query"]?.GetValue<string>() : null;
            var category = args.ContainsKey("category") ? args["category"]?.GetValue<string>() : null;
            var toolNumber = args.ContainsKey("toolNumber") ? args["toolNumber"]?.GetValue<int>() : null;
            var machineGroup = args.ContainsKey("machineGroup") ? args["machineGroup"]?.GetValue<string>() : null;
            var type = args.ContainsKey("type") ? args["type"]?.GetValue<string>() : null;
            var ops = await _adapter.FindOperationsAsync(query, category, toolNumber, machineGroup, type, ct);
            return new { ok = true, tool = "find_operations", data = ops };
        }

        private Task<object> HandleGetStockAsync(CancellationToken ct)
        {
            return Task.FromResult<object>(_adapter.GetStockAsync(ct).Result ?? new { ok = false, error = new { code = ErrorCodes.BackendUnavailable, message = "No stock information" } });
        }

        private Task<object> HandleGetWcsAsync(CancellationToken ct)
        {
            return Task.FromResult<object>(_adapter.GetWcsAsync(ct).Result ?? new { ok = false, error = new { code = ErrorCodes.BackendUnavailable, message = "No WCS information" } });
        }

        private async Task<object> HandleListMachineGroupsAsync(CancellationToken ct)
        {
            var groups = await _adapter.ListMachineGroupsAsync(ct);
            return new { ok = true, tool = "list_machine_groups", data = groups };
        }

        private async Task<object> HandleListToolsAsync(CancellationToken ct)
        {
            var tools = await _adapter.ListToolsAsync(ct);
            return new { ok = true, tool = "list_tools", data = tools };
        }

        private Task<object> HandleGetPostProcessorAsync(CancellationToken ct)
        {
            return Task.FromResult<object>(_adapter.GetPostProcessorAsync(ct).Result ?? new { ok = false, error = new { code = ErrorCodes.BackendUnavailable, message = "No post processor" } });
        }

        private async Task<object> HandleGetToolpathStatusAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationId", out var idNode) || idNode == null)
                return new { ok = false, tool = "get_toolpath_status", error = new { code = ErrorCodes.ValidationFailed, message = "operationId is required" } };
            var operationId = idNode.GetValue<int>();
            var status = await _adapter.GetToolpathStatusAsync(operationId, ct);
            return status != null ? new { ok = true, tool = "get_toolpath_status", data = status } : new { ok = false, tool = "get_toolpath_status", error = new { code = ErrorCodes.OperationNotFound, message = $"Operation {operationId} not found" } };
        }

        private async Task<object> HandleGetOperationParametersAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationId", out var idNode) || idNode == null)
                return new { ok = false, tool = "get_operation_parameters", error = new { code = ErrorCodes.ValidationFailed, message = "operationId is required" } };
            var operationId = idNode.GetValue<int>();
            var paramsResult = await _adapter.GetOperationParametersAsync(operationId, ct);
            return paramsResult != null ? new { ok = true, tool = "get_operation_parameters", data = paramsResult } : new { ok = false, tool = "get_operation_parameters", error = new { code = ErrorCodes.OperationNotFound, message = $"Operation {operationId} not found" } };
        }

        private async Task<object> HandlePreviewOperationParametersAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationId", out var idNode) || idNode == null)
                return new { ok = false, tool = "preview_operation_parameters", error = new { code = ErrorCodes.ValidationFailed, message = "operationId is required" } };
            var operationId = idNode.GetValue<int>();
            var idempotencyKey = args.ContainsKey("idempotencyKey") ? args["idempotencyKey"]?.GetValue<string>() : null;

            Quantity? feedRate = null;
            Quantity? spindleSpeed = null;

            if (args.ContainsKey("changes"))
            {
                var changes = args["changes"]?.AsObject();
                if (changes?.ContainsKey("feedRate") == true)
                    feedRate = new Quantity { Value = changes["feedRate"]!["value"]!.GetValue<double>(), Unit = changes["feedRate"]!["unit"]!.GetValue<string>() };
                if (changes?.ContainsKey("spindleSpeed") == true)
                    spindleSpeed = new Quantity { Value = changes["spindleSpeed"]!["value"]!.GetValue<double>(), Unit = changes["spindleSpeed"]!["unit"]!.GetValue<string>() };
            }

            if (feedRate == null && spindleSpeed == null)
                return new { ok = false, tool = "preview_operation_parameters", error = new { code = ErrorCodes.ValidationFailed, message = "At least one of feedRate or spindleSpeed must be provided" } };

            var result = await _adapter.PreviewOperationParametersAsync(operationId, feedRate, spindleSpeed, idempotencyKey, ct);
            return new { ok = true, tool = "preview_operation_parameters", data = result };
        }

        private async Task<object> HandleApplyOperationParameterPreviewAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("approvalToken", out var tokenNode) || tokenNode == null)
                return new { ok = false, tool = "apply_operation_parameter_preview", error = new { code = ErrorCodes.ValidationFailed, message = "approvalToken is required" } };
            var approvalToken = tokenNode.GetValue<string>();
            var idempotencyKey = args.ContainsKey("idempotencyKey") ? args["idempotencyKey"]?.GetValue<string>() : null;

            var result = await _adapter.ApplyOperationParameterPreviewAsync(approvalToken, idempotencyKey, ct);
            return new { ok = true, tool = "apply_operation_parameter_preview", data = result };
        }

        private async Task<object> HandleVerifyChangeAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationId", out var idNode) || idNode == null)
                return new { ok = false, tool = "verify_change", error = new { code = ErrorCodes.ValidationFailed, message = "operationId is required" } };
            var operationId = idNode.GetValue<int>();
            var documentRevision = args.ContainsKey("documentRevision") ? args["documentRevision"]?.GetValue<string>() : null;

            Quantity? expectedFeedRate = null;
            Quantity? expectedSpindleSpeed = null;

            if (args.ContainsKey("expected"))
            {
                var expected = args["expected"]?.AsObject();
                if (expected?.ContainsKey("feedRate") == true)
                    expectedFeedRate = new Quantity { Value = expected["feedRate"]!["value"]!.GetValue<double>(), Unit = expected["feedRate"]!["unit"]!.GetValue<string>() };
                if (expected?.ContainsKey("spindleSpeed") == true)
                    expectedSpindleSpeed = new Quantity { Value = expected["spindleSpeed"]!["value"]!.GetValue<double>(), Unit = expected["spindleSpeed"]!["unit"]!.GetValue<string>() };
            }

            if (expectedFeedRate == null && expectedSpindleSpeed == null)
                return new { ok = false, tool = "verify_change", error = new { code = ErrorCodes.ValidationFailed, message = "At least one expected value must be provided" } };

            var result = await _adapter.VerifyChangeAsync(operationId, expectedFeedRate, expectedSpindleSpeed, documentRevision, ct);
            return new { ok = true, tool = "verify_change", data = result };
        }

        private async Task<object> HandleRollbackChangeAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("transactionId", out var txNode) || txNode == null)
                return new { ok = false, tool = "rollback_change", error = new { code = ErrorCodes.ValidationFailed, message = "transactionId is required" } };
            var transactionId = txNode.GetValue<string>();
            var idempotencyKey = args.ContainsKey("idempotencyKey") ? args["idempotencyKey"]?.GetValue<string>() : null;

            var result = await _adapter.RollbackChangeAsync(transactionId, idempotencyKey, ct);
            return new { ok = true, tool = "rollback_change", data = result };
        }

        private async Task<object> HandleRegenerateToolpathAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationIds", out var idsNode) || idsNode == null)
                return new { ok = false, tool = "regenerate_toolpath", error = new { code = ErrorCodes.ValidationFailed, message = "operationIds is required" } };
            var operationIds = new List<int>();
            foreach (var id in idsNode.AsArray()) operationIds.Add(id.GetValue<int>());
            var waitForCompletion = args.ContainsKey("waitForCompletion") && args["waitForCompletion"]?.GetValue<bool>() == true;
            var timeoutMs = args.ContainsKey("timeoutMs") ? args["timeoutMs"]?.GetValue<int>() ?? 60000 : 60000;

            var success = await _adapter.RegenerateToolpathAsync(operationIds.ToArray(), waitForCompletion, timeoutMs, ct);
            return new { ok = true, tool = "regenerate_toolpath", data = new { operationIds, regenerated = success } };
        }

        private async Task<object> HandleRunSimulationAsync(JsonObject args, CancellationToken ct)
        {
            int[]? operationIds = null;
            if (args.ContainsKey("operationIds") && args["operationIds"] != null)
            {
                operationIds = new List<int>();
                foreach (var id in args["operationIds"]!.AsArray()) operationIds.Add(id.GetValue<int>());
            }
            var mode = args.ContainsKey("mode") ? args["mode"]?.GetValue<string>() ?? "full" : "full";
            var checkCollisions = args.ContainsKey("checkCollisions") && args["checkCollisions"]?.GetValue<bool>() == true;
            var timeoutMs = args.ContainsKey("timeoutMs") ? args["timeoutMs"]?.GetValue<int>() ?? 120000 : 120000;

            var result = await _adapter.RunSimulationAsync(operationIds, mode, checkCollisions, timeoutMs, ct);
            return new { ok = true, tool = "run_simulation", data = result };
        }

        private async Task<object> HandleDetectCollisionsAsync(JsonObject args, CancellationToken ct)
        {
            int[]? operationIds = null;
            if (args.ContainsKey("operationIds") && args["operationIds"] != null)
            {
                operationIds = new List<int>();
                foreach (var id in args["operationIds"]!.AsArray()) operationIds.Add(id.GetValue<int>());
            }
            var checkHolder = args.ContainsKey("checkHolder") && args["checkHolder"]?.GetValue<bool>() == true;
            var checkRapid = args.ContainsKey("checkRapid") && args["checkRapid"]?.GetValue<bool>() == true;
            var checkWorkpiece = args.ContainsKey("checkWorkpiece") && args["checkWorkpiece"]?.GetValue<bool>() == true;

            var collisions = await _adapter.DetectCollisionsAsync(operationIds, checkHolder, checkRapid, checkWorkpiece, ct);
            return new { ok = true, tool = "detect_collisions", data = new { collisions, checkedOperations = operationIds ?? Array.Empty<int>() } };
        }

        private async Task<object> HandleEstimateCycleTimeAsync(JsonObject args, CancellationToken ct)
        {
            if (!args.TryGetValue("operationId", out var idNode) || idNode == null)
                return new { ok = false, tool = "estimate_cycle_time", error = new { code = ErrorCodes.ValidationFailed, message = "operationId is required" } };
            var operationId = idNode.GetValue<int>();
            var seconds = await _adapter.EstimateCycleTimeAsync(operationId, ct);
            return new { ok = true, tool = "estimate_cycle_time", data = new { operationId, seconds, confidence = "simulated" } };
        }

        private async Task<object> HandleCaptureViewAsync(JsonObject args, CancellationToken ct)
        {
            var operationId = args.ContainsKey("operationId") ? args["operationId"]?.GetValue<int>() : (int?)null;
            var view = args.ContainsKey("view") ? args["view"]?.GetValue<string>() ?? "iso" : "iso";
            var width = args.ContainsKey("resolution") ? (args["resolution"]!["width"]?.GetValue<int>() ?? 800) : 800;
            var height = args.ContainsKey("resolution") ? (args["resolution"]!["height"]?.GetValue<int>() ?? 600) : 600;
            var format = args.ContainsKey("format") ? args["format"]?.GetValue<string>() ?? "png" : "png";
            var showTool = args.ContainsKey("showTool") && args["showTool"]?.GetValue<bool>() == true;
            var showStock = args.ContainsKey("showStock") && args["showStock"]?.GetValue<bool>() == true;
            var showFixture = args.ContainsKey("showFixture") && args["showFixture"]?.GetValue<bool>() == true;

            var imageData = await _adapter.CaptureViewAsync(operationId, view, width, height, format, showTool, showStock, showFixture, ct);
            return new { ok = true, tool = "capture_view", data = new { format, width, height, timestamp = DateTime.UtcNow.ToString("O"), data = Convert.ToBase64String(imageData) } };
        }

        private Task<object> HandleGetVersionReportAsync(CancellationToken ct)
        {
            return Task.FromResult<object>(_adapter.GetVersionReportAsync(ct).Result);
        }

        private async Task<object> HandleGetMachineContextAsync(CancellationToken ct)
        {
            var context = await _adapter.GetMachineContextAsync(ct);
            return new { ok = true, tool = "get_machine_context", data = context };
        }

        private string SerializeError(string? requestId, string code, string message)
        {
            return JsonSerializer.Serialize(new { id = requestId, result = new { ok = false, error = new { code, message } } }, _jsonOptions);
        }
    }
}