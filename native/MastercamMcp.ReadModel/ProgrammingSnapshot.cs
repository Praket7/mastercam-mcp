using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MastercamMcp.ReadModel;

public sealed class SnapshotEvidence
{
    public string Source { get; set; } = "";
    public string? Member { get; set; }
    public string? Note { get; set; }
}

public sealed class SnapshotCoverage
{
    public bool OperationsEnumerated { get; set; }
    public bool StableOperationIds { get; set; }
    public bool ReferencedToolsEnumerated { get; set; }
    public bool PartMapped { get; set; }
    public bool StockMapped { get; set; }
    public bool WcsMapped { get; set; }
    public List<string> Unknowns { get; set; } = new();
}

public sealed class ToolSnapshot
{
    public int? Number { get; set; }
    public string? Name { get; set; }
    public string? Type { get; set; }
    public double? Diameter { get; set; }
    public string? Insert { get; set; }
    public string? Grade { get; set; }
    public string? SourceMember { get; set; }
}

public sealed class OperationSnapshot
{
    public int? Id { get; set; }
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public object? FeedRate { get; set; }
    public object? SpindleSpeed { get; set; }
    public int? Tool { get; set; }
    public bool? ToolpathDirty { get; set; }
    public ToolSnapshot? ToolRecord { get; set; }
    public Dictionary<string, string> Evidence { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class ProgrammingSnapshot
{
    public string Schema { get; set; } = "mastercam-mcp/programming-context/v1";
    public string GeneratedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");
    public string DocumentRevision { get; set; } = "";
    public string Source { get; set; } = "mastercam-net-hook";
    public object? Part { get; set; }
    public object? Machine { get; set; }
    public object? Stock { get; set; }
    public object? Wcs { get; set; }
    public List<object> MachineGroups { get; set; } = new();
    public List<OperationSnapshot> Operations { get; set; } = new();
    public List<ToolSnapshot> Tools { get; set; } = new();
    public SnapshotCoverage Coverage { get; set; } = new();
    public List<SnapshotEvidence> Evidence { get; set; } = new();
}

public sealed class RuntimeProbe
{
    public bool SearchManagerFound { get; set; }
    public bool GetOperationsFound { get; set; }
    public string? SearchManagerAssembly { get; set; }
    public string? GetOperationsReturnType { get; set; }
    public List<string> Notes { get; set; } = new();

    public bool CanReadProgrammingContext => SearchManagerFound && GetOperationsFound;
}

public static class SafeReflection
{
    private static readonly string[] OperationIdMembers =
    {
        "OperationId", "OperationID", "OpId", "OpID", "ID", "Id", "Number"
    };

    private static readonly string[] OperationNameMembers =
    {
        "Name", "OperationName", "Comment", "Description"
    };

    private static readonly string[] OperationTypeMembers =
    {
        "OperationType", "Type", "ToolpathType", "OperationTypeName"
    };

    private static readonly string[] FeedMembers =
    {
        "FeedRate", "Feed", "CutFeedRate", "CutFeed"
    };

    private static readonly string[] SpindleMembers =
    {
        "SpindleSpeed", "RPM", "Rpm", "SpindleRpm"
    };

    private static readonly string[] DirtyMembers =
    {
        "ToolpathDirty", "Dirty", "NeedsRegeneration", "NeedsRegen", "IsDirty"
    };

    private static readonly string[] ToolNumberMembers =
    {
        "ToolNumber", "ToolNo", "ToolNum", "Number", "ID", "Id"
    };

    private static readonly string[] ToolObjectMembers =
    {
        "Tool", "CuttingTool", "ToolData", "ToolDefinition"
    };

    private static readonly string[] ToolNameMembers =
    {
        "Name", "ToolName", "Description"
    };

    private static readonly string[] ToolTypeMembers =
    {
        "Type", "ToolType", "CutterType"
    };

    private static readonly string[] ToolDiameterMembers =
    {
        "Diameter", "ToolDiameter", "CutterDiameter"
    };

    private static readonly string[] InsertMembers =
    {
        "Insert", "InsertName", "InsertId", "InsertID"
    };

    private static readonly string[] GradeMembers =
    {
        "Grade", "InsertGrade"
    };

    public static RuntimeProbe ProbeLoadedAssemblies(IEnumerable<Assembly> assemblies)
    {
        var probe = new RuntimeProbe();
        foreach (var assembly in assemblies)
        {
            Type? searchManager = null;
            try
            {
                searchManager = assembly.GetType("Mastercam.Support.SearchManager", throwOnError: false, ignoreCase: false);
            }
            catch (Exception ex)
            {
                probe.Notes.Add($"{assembly.GetName().Name}: {ex.GetType().Name}");
            }

            if (searchManager == null) continue;

            probe.SearchManagerFound = true;
            probe.SearchManagerAssembly = assembly.GetName().Name;
            var getOperations = searchManager.GetMethod(
                "GetOperations",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null);
            if (getOperations != null)
            {
                probe.GetOperationsFound = true;
                probe.GetOperationsReturnType = getOperations.ReturnType.FullName;
            }
            break;
        }

        if (!probe.SearchManagerFound)
            probe.Notes.Add("Mastercam.Support.SearchManager was not found in the loaded AppDomain.");
        else if (!probe.GetOperationsFound)
            probe.Notes.Add("SearchManager.GetOperations() was not found as a public static zero-argument method.");

        return probe;
    }

    public static IEnumerable<object> EnumerateBounded(object? value, int maxItems)
    {
        if (value is not IEnumerable enumerable) yield break;
        var count = 0;
        foreach (var item in enumerable)
        {
            if (item != null) yield return item;
            count++;
            if (count >= maxItems) yield break;
        }
    }

    public static OperationSnapshot MapOperation(object operation)
    {
        var result = new OperationSnapshot
        {
            Name = operation.GetType().Name,
            Type = operation.GetType().FullName ?? operation.GetType().Name
        };

        if (TryGetInt(operation, OperationIdMembers, out var id, out var idMember))
        {
            result.Id = id;
            result.Evidence["id"] = idMember!;
        }
        if (TryGetString(operation, OperationNameMembers, out var name, out var nameMember) && !string.IsNullOrWhiteSpace(name))
        {
            result.Name = name!;
            result.Evidence["name"] = nameMember!;
        }
        if (TryGetString(operation, OperationTypeMembers, out var type, out var typeMember) && !string.IsNullOrWhiteSpace(type))
        {
            result.Type = type!;
            result.Evidence["type"] = typeMember!;
        }

        if (TryGetScalar(operation, FeedMembers, out var feed, out var feedMember))
        {
            result.FeedRate = feed;
            result.Evidence["feedRate"] = feedMember!;
        }
        if (TryGetScalar(operation, SpindleMembers, out var spindle, out var spindleMember))
        {
            result.SpindleSpeed = spindle;
            result.Evidence["spindleSpeed"] = spindleMember!;
        }
        if (TryGetBool(operation, DirtyMembers, out var dirty, out var dirtyMember))
        {
            result.ToolpathDirty = dirty;
            result.Evidence["toolpathDirty"] = dirtyMember!;
        }
        if (TryGetInt(operation, ToolNumberMembers, out var toolNumber, out var toolNumberMember))
        {
            result.Tool = toolNumber;
            result.Evidence["tool"] = toolNumberMember!;
        }

        if (TryGetObject(operation, ToolObjectMembers, out var toolObject, out var toolMember) && toolObject != null)
        {
            result.ToolRecord = MapTool(toolObject);
            result.ToolRecord.SourceMember = toolMember;
            if (result.Tool == null && result.ToolRecord.Number != null)
                result.Tool = result.ToolRecord.Number;
        }

        return result;
    }

    public static ToolSnapshot MapTool(object tool)
    {
        var result = new ToolSnapshot();
        if (TryGetInt(tool, ToolNumberMembers, out var number, out _)) result.Number = number;
        if (TryGetString(tool, ToolNameMembers, out var name, out _)) result.Name = name;
        if (TryGetString(tool, ToolTypeMembers, out var type, out _)) result.Type = type;
        if (TryGetDouble(tool, ToolDiameterMembers, out var diameter, out _)) result.Diameter = diameter;
        if (TryGetString(tool, InsertMembers, out var insert, out _)) result.Insert = insert;
        if (TryGetString(tool, GradeMembers, out var grade, out _)) result.Grade = grade;
        return result;
    }

    public static ProgrammingSnapshot BuildProgrammingSnapshot(
        IEnumerable<object> operationObjects,
        string sourceMember,
        int maxOperations = 5000)
    {
        var snapshot = new ProgrammingSnapshot();
        var seenTools = new Dictionary<string, ToolSnapshot>(StringComparer.OrdinalIgnoreCase);
        var count = 0;

        foreach (var operationObject in operationObjects)
        {
            if (count++ >= maxOperations)
            {
                snapshot.Coverage.Unknowns.Add($"Operation enumeration was truncated at {maxOperations} records.");
                break;
            }

            var operation = MapOperation(operationObject);
            snapshot.Operations.Add(operation);

            var tool = operation.ToolRecord;
            if (tool != null)
            {
                var key = tool.Number?.ToString() ?? tool.Name ?? $"object:{RuntimeHelpers.GetHashCode(tool)}";
                if (!seenTools.ContainsKey(key)) seenTools[key] = tool;
            }
            else if (operation.Tool != null)
            {
                var key = operation.Tool.Value.ToString();
                if (!seenTools.ContainsKey(key))
                    seenTools[key] = new ToolSnapshot { Number = operation.Tool };
            }
        }

        snapshot.Tools = seenTools.Values
            .OrderBy(t => t.Number ?? int.MaxValue)
            .ThenBy(t => t.Name ?? "")
            .ToList();

        snapshot.Coverage.OperationsEnumerated = true;
        snapshot.Coverage.StableOperationIds =
            snapshot.Operations.Count > 0 &&
            snapshot.Operations.All(op => op.Id.HasValue) &&
            snapshot.Operations.Select(op => op.Id!.Value).Distinct().Count() == snapshot.Operations.Count;
        snapshot.Coverage.ReferencedToolsEnumerated = snapshot.Tools.Count > 0;
        snapshot.Coverage.PartMapped = snapshot.Part != null;
        snapshot.Coverage.StockMapped = snapshot.Stock != null;
        snapshot.Coverage.WcsMapped = snapshot.Wcs != null;

        if (!snapshot.Coverage.StableOperationIds)
            snapshot.Coverage.Unknowns.Add("A stable numeric operation identifier could not be proven for every returned operation.");
        if (!snapshot.Coverage.ReferencedToolsEnumerated)
            snapshot.Coverage.Unknowns.Add("No referenced tool records could be extracted from the returned operation objects.");
        if (!snapshot.Coverage.PartMapped)
            snapshot.Coverage.Unknowns.Add("Active part identity is not mapped in the current Stage-B reader.");
        if (!snapshot.Coverage.StockMapped)
            snapshot.Coverage.Unknowns.Add("Stock is not mapped in the current Stage-B reader.");
        if (!snapshot.Coverage.WcsMapped)
            snapshot.Coverage.Unknowns.Add("WCS is not mapped in the current Stage-B reader.");

        snapshot.Evidence.Add(new SnapshotEvidence
        {
            Source = "Mastercam.Support.SearchManager.GetOperations",
            Member = sourceMember,
            Note = "Public NET-Hook example evidence establishes operation enumeration; per-field mappings are runtime-reflected and reported individually."
        });

        snapshot.DocumentRevision = ComputeRevision(snapshot);
        return snapshot;
    }

    public static string ComputeRevision(ProgrammingSnapshot snapshot)
    {
        var stable = new
        {
            operations = snapshot.Operations.Select(op => new
            {
                op.Id,
                op.Name,
                op.Type,
                op.FeedRate,
                op.SpindleSpeed,
                op.Tool,
                op.ToolpathDirty
            }).ToArray(),
            tools = snapshot.Tools.Select(tool => new
            {
                tool.Number,
                tool.Name,
                tool.Type,
                tool.Diameter,
                tool.Insert,
                tool.Grade
            }).ToArray()
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(stable);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    public static bool TryGetObject(object target, IEnumerable<string> names, out object? value, out string? memberName)
    {
        foreach (var name in names)
        {
            if (TryReadMember(target, name, out value))
            {
                memberName = name;
                return true;
            }
        }
        value = null;
        memberName = null;
        return false;
    }

    public static bool TryGetString(object target, IEnumerable<string> names, out string? value, out string? memberName)
    {
        foreach (var name in names)
        {
            if (!TryReadMember(target, name, out var raw) || raw == null) continue;
            if (raw is string s)
            {
                value = s;
                memberName = name;
                return true;
            }
            if (raw.GetType().IsEnum || raw is char)
            {
                value = raw.ToString();
                memberName = name;
                return true;
            }
        }
        value = null;
        memberName = null;
        return false;
    }

    public static bool TryGetInt(object target, IEnumerable<string> names, out int value, out string? memberName)
    {
        foreach (var name in names)
        {
            if (!TryReadMember(target, name, out var raw) || raw == null) continue;
            try
            {
                if (raw is bool) continue;
                var converted = Convert.ToInt64(raw);
                if (converted < int.MinValue || converted > int.MaxValue) continue;
                value = (int)converted;
                memberName = name;
                return true;
            }
            catch { }
        }
        value = default;
        memberName = null;
        return false;
    }

    public static bool TryGetDouble(object target, IEnumerable<string> names, out double value, out string? memberName)
    {
        foreach (var name in names)
        {
            if (!TryReadMember(target, name, out var raw) || raw == null) continue;
            try
            {
                if (raw is bool) continue;
                var converted = Convert.ToDouble(raw);
                if (!double.IsFinite(converted)) continue;
                value = converted;
                memberName = name;
                return true;
            }
            catch { }
        }
        value = default;
        memberName = null;
        return false;
    }

    public static bool TryGetBool(object target, IEnumerable<string> names, out bool value, out string? memberName)
    {
        foreach (var name in names)
        {
            if (!TryReadMember(target, name, out var raw) || raw == null) continue;
            if (raw is bool b)
            {
                value = b;
                memberName = name;
                return true;
            }
        }
        value = default;
        memberName = null;
        return false;
    }

    public static bool TryGetScalar(object target, IEnumerable<string> names, out object? value, out string? memberName)
    {
        foreach (var name in names)
        {
            if (!TryReadMember(target, name, out var raw) || raw == null) continue;
            var type = raw.GetType();
            if (raw is string || raw is bool || raw is byte || raw is sbyte ||
                raw is short || raw is ushort || raw is int || raw is uint ||
                raw is long || raw is ulong || raw is float || raw is double ||
                raw is decimal || type.IsEnum)
            {
                value = type.IsEnum ? raw.ToString() : raw;
                memberName = name;
                return true;
            }

            // Quantity-like value objects are common in APIs. Preserve only
            // bounded primitive properties so arbitrary object graphs are never serialized.
            if (TryReadMember(raw, "Value", out var quantityValue) && quantityValue != null)
            {
                var payload = new Dictionary<string, object?>();
                if (TryConvertFiniteNumber(quantityValue, out var number)) payload["value"] = number;
                if (TryReadMember(raw, "Unit", out var unit) && unit != null) payload["unit"] = unit.ToString();
                if (TryReadMember(raw, "Units", out var units) && units != null && !payload.ContainsKey("unit"))
                    payload["unit"] = units.ToString();
                if (payload.Count > 0)
                {
                    value = payload;
                    memberName = name;
                    return true;
                }
            }
        }
        value = null;
        memberName = null;
        return false;
    }

    private static bool TryReadMember(object target, string name, out object? value)
    {
        value = null;
        try
        {
            var type = target.GetType();
            var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (property != null && property.GetIndexParameters().Length == 0 && property.GetMethod != null)
            {
                value = property.GetValue(target);
                return true;
            }

            var field = type.GetField(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (field != null)
            {
                value = field.GetValue(target);
                return true;
            }
        }
        catch
        {
            // Vendor getters are not allowed to tear down a read snapshot.
        }
        return false;
    }

    private static bool TryConvertFiniteNumber(object raw, out double value)
    {
        try
        {
            value = Convert.ToDouble(raw);
            return double.IsFinite(value);
        }
        catch
        {
            value = default;
            return false;
        }
    }
}
