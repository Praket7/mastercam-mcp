using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.ReadModel;

namespace MastercamMcp.Addin.2027
{
    internal static class ProgrammingContextTools
    {
        private static readonly HashSet<string> Names = new(StringComparer.OrdinalIgnoreCase)
        {
            "get_programming_context",
            "list_operations",
            "get_operation",
            "get_operation_parameters",
            "find_operations",
            "get_dirty_toolpaths",
            "get_toolpath_status",
            "list_tools",
            "get_tool"
        };

        public static bool CanHandle(string tool) => Names.Contains(tool);

        public static AdapterResult Invoke(
            string tool,
            string argumentsJson,
            CancellationToken cancellationToken)
        {
            if (!ProgrammingContextReader.TryRead(
                    cancellationToken,
                    out var snapshot,
                    out var errorCode,
                    out var errorMessage))
            {
                return AdapterResult.Failure(
                    errorCode ?? "BACKEND_UNAVAILABLE",
                    errorMessage ?? "Unable to build the Mastercam programming-context snapshot");
            }

            if (snapshot == null)
                return AdapterResult.Failure("BACKEND_UNAVAILABLE", "Programming-context reader returned no snapshot");

            cancellationToken.ThrowIfCancellationRequested();

            JsonDocument? arguments = null;
            try
            {
                arguments = JsonDocument.Parse(string.IsNullOrWhiteSpace(argumentsJson) ? "{}" : argumentsJson);
                var root = arguments.RootElement;

                return tool switch
                {
                    "get_programming_context" => AdapterResult.Success(snapshot, snapshot.DocumentRevision),
                    "list_operations" => ListOperations(snapshot, root),
                    "get_operation" => GetOperation(snapshot, root),
                    "get_operation_parameters" => GetOperationParameters(snapshot, root),
                    "find_operations" => FindOperations(snapshot, root),
                    "get_dirty_toolpaths" => GetDirtyToolpaths(snapshot, root),
                    "get_toolpath_status" => GetToolpathStatus(snapshot, root),
                    "list_tools" => ListTools(snapshot, root),
                    "get_tool" => GetTool(snapshot, root),
                    _ => AdapterResult.Failure("UNSUPPORTED_CAPABILITY", $"Stage-B reader does not handle {tool}")
                };
            }
            catch (JsonException ex)
            {
                return AdapterResult.Failure("VALIDATION_FAILED", $"Invalid Stage-B read arguments: {ex.Message}");
            }
            finally
            {
                arguments?.Dispose();
            }
        }

        private static AdapterResult ListOperations(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var stable = RequireStableOperationIds(snapshot);
            if (stable != null) return stable;

            var limit = GetInt(root, "limit", 100, 1, 500);
            var offset = GetInt(root, "offset", 0, 0, int.MaxValue);
            var operationType = GetString(root, "operationType");

            IEnumerable<OperationSnapshot> query = snapshot.Operations;
            if (!string.IsNullOrWhiteSpace(operationType))
            {
                query = query.Where(op =>
                    op.Type.Contains(operationType, StringComparison.OrdinalIgnoreCase));
            }

            var data = query
                .Skip(offset)
                .Take(limit)
                .Select(OperationListPayload)
                .ToArray();

            return AdapterResult.Success(data, snapshot.DocumentRevision);
        }

        private static AdapterResult GetOperation(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var stable = RequireStableOperationIds(snapshot);
            if (stable != null) return stable;
            if (!TryGetRequiredPositiveInt(root, "operationId", out var operationId, out var error))
                return AdapterResult.Failure("VALIDATION_FAILED", error!);

            var operation = snapshot.Operations.FirstOrDefault(op => op.Id == operationId);
            if (operation == null)
                return AdapterResult.Failure("TARGET_NOT_FOUND", $"Operation {operationId} was not found in the current programming snapshot");

            return AdapterResult.Success(new
            {
                id = operation.Id!.Value,
                name = operation.Name,
                type = operation.Type,
                feedRate = operation.FeedRate,
                spindleSpeed = operation.SpindleSpeed,
                tool = operation.Tool,
                toolpathDirty = operation.ToolpathDirty,
                documentRevision = snapshot.DocumentRevision,
                operationFingerprint = SafeReflection.ComputeOperationFingerprint(operation),
                mappingEvidence = operation.Evidence
            }, snapshot.DocumentRevision);
        }

        private static AdapterResult GetOperationParameters(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var stable = RequireStableOperationIds(snapshot);
            if (stable != null) return stable;
            if (!TryGetRequiredPositiveInt(root, "operationId", out var operationId, out var error))
                return AdapterResult.Failure("VALIDATION_FAILED", error!);

            var operation = snapshot.Operations.FirstOrDefault(op => op.Id == operationId);
            if (operation == null)
                return AdapterResult.Failure("TARGET_NOT_FOUND", $"Operation {operationId} was not found in the current programming snapshot");

            var parameters = new Dictionary<string, object?>
            {
                ["name"] = operation.Name,
                ["type"] = operation.Type,
                ["feedRate"] = operation.FeedRate,
                ["spindleSpeed"] = operation.SpindleSpeed,
                ["tool"] = operation.Tool,
                ["toolpathDirty"] = operation.ToolpathDirty,
                ["mappingEvidence"] = operation.Evidence,
                ["partial"] = true,
                ["note"] = "Stage-B exposes only fields proven by bounded runtime reflection; absent Mastercam parameters are not invented."
            };

            return AdapterResult.Success(new
            {
                operationId,
                parameters,
                documentRevision = snapshot.DocumentRevision
            }, snapshot.DocumentRevision);
        }

        private static AdapterResult FindOperations(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var stable = RequireStableOperationIds(snapshot);
            if (stable != null) return stable;

            var queryText = GetString(root, "query");
            var operationType = GetString(root, "operationType");
            int? toolNumber = null;
            if (root.TryGetProperty("toolNumber", out var toolElement) &&
                toolElement.ValueKind == JsonValueKind.Number &&
                toolElement.TryGetInt32(out var parsedTool) &&
                parsedTool > 0)
            {
                toolNumber = parsedTool;
            }
            var limit = GetInt(root, "limit", 50, 1, 200);

            IEnumerable<OperationSnapshot> query = snapshot.Operations;
            if (!string.IsNullOrWhiteSpace(queryText))
            {
                query = query.Where(op =>
                    op.Name.Contains(queryText, StringComparison.OrdinalIgnoreCase) ||
                    op.Type.Contains(queryText, StringComparison.OrdinalIgnoreCase));
            }
            if (!string.IsNullOrWhiteSpace(operationType))
            {
                query = query.Where(op =>
                    op.Type.Contains(operationType, StringComparison.OrdinalIgnoreCase));
            }
            if (toolNumber.HasValue)
                query = query.Where(op => op.Tool == toolNumber.Value);

            return AdapterResult.Success(
                query.Take(limit).Select(OperationListPayload).ToArray(),
                snapshot.DocumentRevision);
        }

        private static AdapterResult GetDirtyToolpaths(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var stable = RequireStableOperationIds(snapshot);
            if (stable != null) return stable;

            HashSet<int>? requested = null;
            if (root.TryGetProperty("operationIds", out var ids) && ids.ValueKind == JsonValueKind.Array)
            {
                requested = new HashSet<int>();
                foreach (var item in ids.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out var id) && id > 0)
                        requested.Add(id);
                }
            }

            var scoped = requested == null
                ? snapshot.Operations
                : snapshot.Operations.Where(op => op.Id.HasValue && requested.Contains(op.Id.Value)).ToList();

            return AdapterResult.Success(new
            {
                operationIds = scoped.Where(op => op.ToolpathDirty == true).Select(op => op.Id!.Value).ToArray(),
                unknownOperationIds = scoped.Where(op => op.ToolpathDirty == null).Select(op => op.Id!.Value).ToArray(),
                documentRevision = snapshot.DocumentRevision,
                note = "Unknown dirty state remains unknown; it is never treated as current."
            }, snapshot.DocumentRevision);
        }

        private static AdapterResult GetToolpathStatus(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var stable = RequireStableOperationIds(snapshot);
            if (stable != null) return stable;
            if (!TryGetRequiredPositiveInt(root, "operationId", out var operationId, out var error))
                return AdapterResult.Failure("VALIDATION_FAILED", error!);

            var operation = snapshot.Operations.FirstOrDefault(op => op.Id == operationId);
            if (operation == null)
                return AdapterResult.Failure("TARGET_NOT_FOUND", $"Operation {operationId} was not found in the current programming snapshot");

            var state = operation.ToolpathDirty == true
                ? "dirty"
                : operation.ToolpathDirty == false
                    ? "current"
                    : "unknown";

            return AdapterResult.Success(new
            {
                operationId,
                state,
                toolpathDirty = operation.ToolpathDirty,
                documentRevision = snapshot.DocumentRevision,
                evidence = operation.Evidence.TryGetValue("toolpathDirty", out var member) ? member : null,
                note = operation.ToolpathDirty.HasValue
                    ? "State was read from the mapped operation member shown in evidence."
                    : "No proven dirty/regeneration member was found; status remains unknown."
            }, snapshot.DocumentRevision);
        }

        private static AdapterResult ListTools(ProgrammingSnapshot snapshot, JsonElement root)
        {
            var limit = GetInt(root, "limit", 200, 1, 500);
            var data = snapshot.Tools.Take(limit).Select(ToolPayload).ToArray();
            return AdapterResult.Success(new
            {
                tools = data,
                coverage = new
                {
                    referencedToolsOnly = true,
                    completeLibrary = false,
                    source = "tools referenced by active operations",
                    unknowns = snapshot.Coverage.ReferencedToolsEnumerated
                        ? Array.Empty<string>()
                        : new[] { "No referenced tool records were extracted from the active operations." }
                },
                documentRevision = snapshot.DocumentRevision
            }, snapshot.DocumentRevision);
        }

        private static AdapterResult GetTool(ProgrammingSnapshot snapshot, JsonElement root)
        {
            if (!root.TryGetProperty("toolId", out var toolId))
                return AdapterResult.Failure("VALIDATION_FAILED", "toolId is required");

            ToolSnapshot? tool = null;
            if (toolId.ValueKind == JsonValueKind.Number && toolId.TryGetInt32(out var number))
            {
                tool = snapshot.Tools.FirstOrDefault(candidate => candidate.Number == number);
            }
            else if (toolId.ValueKind == JsonValueKind.String)
            {
                var text = toolId.GetString();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    tool = snapshot.Tools.FirstOrDefault(candidate =>
                        string.Equals(candidate.Name, text, StringComparison.OrdinalIgnoreCase) ||
                        (candidate.Number.HasValue && candidate.Number.Value.ToString() == text));
                }
            }

            if (tool == null)
                return AdapterResult.Failure("TARGET_NOT_FOUND", "The requested tool was not found among tools referenced by the active operations");

            return AdapterResult.Success(new
            {
                tool = ToolPayload(tool),
                scope = "referenced-active-operation-tools",
                completeLibrary = false,
                documentRevision = snapshot.DocumentRevision
            }, snapshot.DocumentRevision);
        }

        private static object OperationListPayload(OperationSnapshot operation) => new
        {
            id = operation.Id!.Value,
            name = operation.Name,
            type = operation.Type,
            feedRate = operation.FeedRate,
            feed = operation.FeedRate,
            spindleSpeed = operation.SpindleSpeed,
            tool = operation.Tool,
            toolpathDirty = operation.ToolpathDirty,
            mappingEvidence = operation.Evidence
        };

        private static object ToolPayload(ToolSnapshot tool) => new
        {
            id = tool.Number?.ToString() ?? tool.Name,
            number = tool.Number,
            name = tool.Name,
            type = tool.Type,
            diameter = tool.Diameter,
            insert = tool.Insert,
            grade = tool.Grade,
            provenance = new
            {
                source = "active-operation-reference",
                member = tool.SourceMember,
                completeLibraryRecord = false
            }
        };

        private static AdapterResult? RequireStableOperationIds(ProgrammingSnapshot snapshot)
        {
            return snapshot.Coverage.StableOperationIds
                ? null
                : AdapterResult.Failure(
                    "MAPPING_INCOMPLETE",
                    "Stable unique numeric operation IDs were not proven for every active operation; identity-dependent reads are disabled to prevent fallback targeting.");
        }

        private static int GetInt(JsonElement root, string name, int fallback, int min, int max)
        {
            if (!root.TryGetProperty(name, out var element) ||
                element.ValueKind != JsonValueKind.Number ||
                !element.TryGetInt32(out var value))
                return fallback;
            return Math.Clamp(value, min, max);
        }

        private static string? GetString(JsonElement root, string name)
        {
            return root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
                ? element.GetString()
                : null;
        }

        private static bool TryGetRequiredPositiveInt(
            JsonElement root,
            string name,
            out int value,
            out string? error)
        {
            value = 0;
            error = null;
            if (!root.TryGetProperty(name, out var element) ||
                element.ValueKind != JsonValueKind.Number ||
                !element.TryGetInt32(out value) ||
                value <= 0)
            {
                error = $"{name} must be a positive integer";
                return false;
            }
            return true;
        }
    }
}
