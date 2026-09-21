using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Protocol;

namespace MastercamMcp.Adapter.Abstractions
{
    public sealed class CapabilityEntry
    {
        public string Name { get; init; } = string.Empty;
        public bool Supported { get; init; }
        public string Mode { get; init; } = "read";
        public string RiskClass { get; init; } = "inspect";
        public bool RequiresActiveDocument { get; init; }
        public bool RequiresSelectedOperation { get; init; }
        public bool RequiresRegeneration { get; init; }
        public int IntroducedAdapterVersion { get; init; }
        public string[] MastercamReleaseSupport { get; init; } = System.Array.Empty<string>();
        public string VerificationStatus { get; init; } = "source_only";
        public string? Reason { get; init; }
    }

    public sealed class CapabilityRegistry
    {
        public string AdapterVersion { get; init; } = string.Empty;
        public string MastercamVersion { get; init; } = string.Empty;
        public string Runtime { get; init; } = string.Empty;
        public Dictionary<string, CapabilityEntry> Tools { get; init; } = new();
    }

    public sealed class OperationSummary
    {
        public int Id { get; init; }
        public string Name { get; init; } = string.Empty;
        public string Type { get; init; } = string.Empty;
        public string Strategy { get; init; } = string.Empty;
        public Quantity? FeedRate { get; init; }
        public Quantity? SpindleSpeed { get; init; }
        public ToolReference? Tool { get; init; }
        public Dictionary<string, object>? Parameters { get; init; }
        public string? Wcs { get; init; }
        public string? MachineGroup { get; init; }
        public bool? Enabled { get; init; }
        public bool? Dirty { get; init; }
        public int[]? GeometryIds { get; init; }
    }

    public sealed class ToolReference
    {
        public int Number { get; init; }
        public string? Name { get; init; }
    }

    public sealed class Quantity
    {
        public double Value { get; init; }
        public string Unit { get; init; } = string.Empty;
    }

    public sealed class ActivePart
    {
        public string Name { get; init; } = string.Empty;
        public string Path { get; init; } = string.Empty;
        public string Units { get; init; } = string.Empty;
        public bool Modified { get; init; }
        public string Revision { get; init; } = string.Empty;
        public string Fingerprint { get; init; } = string.Empty;
    }

    public sealed class MachineGroup
    {
        public string Id { get; init; } = string.Empty;
        public string Name { get; init; } = string.Empty;
        public string Type { get; init; } = string.Empty;
    }

    public sealed class Stock
    {
        public Dimensions Dimensions { get; init; } = new();
        public string Units { get; init; } = string.Empty;
        public string? Material { get; init; }
        public string? Source { get; init; }
    }

    public sealed class Dimensions
    {
        public double X { get; init; }
        public double Y { get; init; }
        public double Z { get; init; }
    }

    public sealed class Wcs
    {
        public string Name { get; init; } = string.Empty;
        public double[] Origin { get; init; } = new double[3];
        public Dictionary<string, double[]> Axes { get; init; } = new();
        public bool? Active { get; init; }
    }

    public sealed class PostProcessor
    {
        public string Name { get; init; } = string.Empty;
        public string Extension { get; init; } = string.Empty;
        public string Machine { get; init; } = string.Empty;
        public string? Version { get; init; }
    }

    public sealed class Tool
    {
        public int Number { get; init; }
        public string Name { get; init; } = string.Empty;
        public double? Diameter { get; init; }
        public double? Length { get; init; }
        public string Units { get; init; } = string.Empty;
        public string? Type { get; init; }
        public string? Holder { get; init; }
        public int? FluteCount { get; init; }
        public bool? Coolant { get; init; }
    }

    public sealed class ToolpathStatus
    {
        public int OperationId { get; init; }
        public bool Generated { get; init; }
        public bool Valid { get; init; }
        public bool Dirty { get; init; }
        public string CollisionState { get; init; } = string.Empty;
        public string? LastRegenerated { get; init; }
    }

    public sealed class OperationParameters
    {
        public int OperationId { get; init; }
        public Quantity? FeedRate { get; init; }
        public Quantity? SpindleSpeed { get; init; }
        public Quantity? Stepdown { get; init; }
        public Quantity? Stepover { get; init; }
        public Quantity? Depth { get; init; }
        public Quantity? LeadIn { get; init; }
        public Quantity? LeadOut { get; init; }
        public string? Approach { get; init; }
        public string? Retract { get; init; }
    }

    public sealed class PreviewResult
    {
        public OperationParameters Before { get; init; } = new();
        public OperationParameters After { get; init; } = new();
        public bool RequiresRegeneration { get; init; }
        public bool RollbackAvailable { get; init; }
        public string ApprovalToken { get; init; } = string.Empty;
        public string ExpiresAt { get; init; } = string.Empty;
        public string DocumentRevision { get; init; } = string.Empty;
        public string OperationFingerprint { get; init; } = string.Empty;
        public Risk[] Risks { get; init; } = System.Array.Empty<Risk>();
    }

    public sealed class Risk
    {
        public string Code { get; init; } = string.Empty;
        public string Severity { get; init; } = string.Empty;
        public string Message { get; init; } = string.Empty;
    }

    public sealed class ApplyResult
    {
        public bool Applied { get; init; }
        public string TransactionId { get; init; } = string.Empty;
        public string DocumentRevision { get; init; } = string.Empty;
        public string OperationFingerprint { get; init; } = string.Empty;
        public OperationParameters Before { get; init; } = new();
        public OperationParameters After { get; init; } = new();
        public bool Regenerated { get; init; }
        public Verification Verification { get; init; } = new();
    }

    public sealed class Verification
    {
        public bool Pass { get; init; }
        public bool Reread { get; init; }
        public Quantity? ActualFeedRate { get; init; }
        public Quantity? ActualSpindleSpeed { get; init; }
    }

    public sealed class TransactionReceipt
    {
        public string TransactionId { get; init; } = string.Empty;
        public string PartFingerprint { get; init; } = string.Empty;
        public int OperationId { get; init; }
        public string BeforeHash { get; init; } = string.Empty;
        public string AfterHash { get; init; } = string.Empty;
        public OperationParameters Before { get; init; } = new();
        public OperationParameters After { get; init; } = new();
        public string CreatedAt { get; init; } = string.Empty;
        public string ExpiresAt { get; init; } = string.Empty;
    }

    public sealed class SimulationResult
    {
        public string State { get; init; } = string.Empty;
        public double DurationSeconds { get; init; }
        public Collision[] Collisions { get; init; } = System.Array.Empty<Collision>();
        public string[] Warnings { get; init; } = System.Array.Empty<string>();
        public double? CycleTimeEstimate { get; init; }
        public int OperationsSimulated { get; init; }
    }

    public sealed class Collision
    {
        public int OperationId { get; init; }
        public string Type { get; init; } = string.Empty;
        public string Severity { get; init; } = string.Empty;
        public double[]? Position { get; init; }
        public string Description { get; init; } = string.Empty;
    }

    public interface IMastercamAdapter
    {
        string AdapterVersion { get; }
        string SupportedRuntime { get; }
        string[] SupportedReleases { get; }
        CapabilityRegistry GetCapabilities();
        Task<ActivePart?> GetActivePartAsync(CancellationToken ct = default);
        Task<IReadOnlyList<OperationSummary>> ListOperationsAsync(bool includeDisabled = false, string? machineGroup = null, CancellationToken ct = default);
        Task<OperationSummary?> GetOperationAsync(int operationId, CancellationToken ct = default);
        Task<IReadOnlyList<OperationSummary>> FindOperationsAsync(string? query = null, string? category = null, int? toolNumber = null, string? machineGroup = null, string? type = null, CancellationToken ct = default);
        Task<Stock?> GetStockAsync(CancellationToken ct = default);
        Task<Wcs?> GetWcsAsync(CancellationToken ct = default);
        Task<IReadOnlyList<MachineGroup>> ListMachineGroupsAsync(CancellationToken ct = default);
        Task<IReadOnlyList<Tool>> ListToolsAsync(CancellationToken ct = default);
        Task<PostProcessor?> GetPostProcessorAsync(CancellationToken ct = default);
        Task<ToolpathStatus?> GetToolpathStatusAsync(int operationId, CancellationToken ct = default);
        Task<OperationParameters?> GetOperationParametersAsync(int operationId, CancellationToken ct = default);
        Task<PreviewResult> PreviewOperationParametersAsync(int operationId, Quantity? feedRate, Quantity? spindleSpeed, string? idempotencyKey, CancellationToken ct = default);
        Task<ApplyResult> ApplyOperationParameterPreviewAsync(string approvalToken, string? idempotencyKey, CancellationToken ct = default);
        Task<Verification> VerifyChangeAsync(int operationId, Quantity? expectedFeedRate, Quantity? expectedSpindleSpeed, string? documentRevision, CancellationToken ct = default);
        Task<ApplyResult> RollbackChangeAsync(string transactionId, string? idempotencyKey, CancellationToken ct = default);
        Task<SimulationResult> RunSimulationAsync(int[]? operationIds, string mode, bool checkCollisions, int timeoutMs, CancellationToken ct = default);
        Task<Collision[]> DetectCollisionsAsync(int[]? operationIds, bool checkHolder, bool checkRapid, bool checkWorkpiece, CancellationToken ct = default);
        Task<double?> EstimateCycleTimeAsync(int operationId, CancellationToken ct = default);
        Task<byte[]> CaptureViewAsync(int? operationId, string view, int width, int height, string format, bool showTool, bool showStock, bool showFixture, CancellationToken ct = default);
        Task<bool> RegenerateToolpathAsync(int[] operationIds, bool waitForCompletion, int timeoutMs, CancellationToken ct = default);
        Task<string> GetVersionReportAsync(CancellationToken ct = default);
        Task<MachineContext> GetMachineContextAsync(CancellationToken ct = default);
    }

    public sealed class MachineContext
    {
        public MachineInfo Machine { get; init; } = new();
        public Stock Stock { get; init; } = new();
        public Workholding Workholding { get; init; } = new();
        public string Wcs { get; init; } = string.Empty;
        public string Safety { get; init; } = string.Empty;
    }

    public sealed class MachineInfo
    {
        public string Name { get; init; } = string.Empty;
        public string Type { get; init; } = string.Empty;
        public int Axes { get; init; }
    }

    public sealed class Workholding
    {
        public string State { get; init; } = string.Empty;
        public bool Verified { get; init; }
    }
}