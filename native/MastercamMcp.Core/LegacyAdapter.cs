using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MastercamMcp.Adapter.Abstractions;
using MastercamMcp.Protocol;

namespace MastercamMcp.Core
{
    public class LegacyAdapter : IMastercamAdapter
    {
        public string AdapterVersion => "0.1.6-legacy";
        public string SupportedRuntime => ".NET Framework 4.8";
        public string[] SupportedReleases => new[] { "2024", "2025", "2026" };

        public CapabilityRegistry GetCapabilities()
        {
            var tools = new Dictionary<string, CapabilityEntry>
            {
                ["mastercam_status"] = new() { Name = "mastercam_status", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = false, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["mastercam_capabilities"] = new() { Name = "mastercam_capabilities", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = false, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_active_part"] = new() { Name = "get_active_part", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["list_operations"] = new() { Name = "list_operations", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_operation"] = new() { Name = "get_operation", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["find_operations"] = new() { Name = "find_operations", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_stock"] = new() { Name = "get_stock", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_wcs"] = new() { Name = "get_wcs", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["list_machine_groups"] = new() { Name = "list_machine_groups", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["list_tools"] = new() { Name = "list_tools", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_post_processor"] = new() { Name = "get_post_processor", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_toolpath_status"] = new() { Name = "get_toolpath_status", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_operation_parameters"] = new() { Name = "get_operation_parameters", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["preview_operation_parameters"] = new() { Name = "preview_operation_parameters", Supported = false, Mode = "write", RiskClass = "edit", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = true, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["apply_operation_parameter_preview"] = new() { Name = "apply_operation_parameter_preview", Supported = false, Mode = "write", RiskClass = "edit", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = true, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["verify_change"] = new() { Name = "verify_change", Supported = false, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["rollback_change"] = new() { Name = "rollback_change", Supported = false, Mode = "write", RiskClass = "edit", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = true, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["regenerate_toolpath"] = new() { Name = "regenerate_toolpath", Supported = false, Mode = "write", RiskClass = "advanced", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = true, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["run_simulation"] = new() { Name = "run_simulation", Supported = false, Mode = "write", RiskClass = "advanced", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["detect_collisions"] = new() { Name = "detect_collisions", Supported = false, Mode = "write", RiskClass = "advanced", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["estimate_cycle_time"] = new() { Name = "estimate_cycle_time", Supported = false, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = true, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["capture_view"] = new() { Name = "capture_view", Supported = false, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "source_only", Reason = "not_live_verified" },
                ["get_version_report"] = new() { Name = "get_version_report", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = false, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" },
                ["get_machine_context"] = new() { Name = "get_machine_context", Supported = true, Mode = "read", RiskClass = "inspect", RequiresActiveDocument = true, RequiresSelectedOperation = false, RequiresRegeneration = false, IntroducedAdapterVersion = 1, MastercamReleaseSupport = SupportedReleases, VerificationStatus = "live_read_verified" }
            };

            return new CapabilityRegistry
            {
                AdapterVersion = AdapterVersion,
                MastercamVersion = SupportedReleases[0],
                Runtime = SupportedRuntime,
                Tools = tools
            };
        }

        public Task<ActivePart?> GetActivePartAsync(CancellationToken ct = default)
        {
            return Task.FromResult<ActivePart?>(new ActivePart
            {
                Name = "unknown",
                Path = "unknown",
                Units = "mm",
                Modified = false,
                Revision = "rev-1",
                Fingerprint = "unknown"
            });
        }

        public Task<IReadOnlyList<OperationSummary>> ListOperationsAsync(bool includeDisabled = false, string? machineGroup = null, CancellationToken ct = default)
        {
            return Task.FromResult<IReadOnlyList<OperationSummary>>(Array.Empty<OperationSummary>());
        }

        public Task<OperationSummary?> GetOperationAsync(int operationId, CancellationToken ct = default)
        {
            return Task.FromResult<OperationSummary?>(null);
        }

        public Task<IReadOnlyList<OperationSummary>> FindOperationsAsync(string? query = null, string? category = null, int? toolNumber = null, string? machineGroup = null, string? type = null, CancellationToken ct = default)
        {
            return Task.FromResult<IReadOnlyList<OperationSummary>>(Array.Empty<OperationSummary>());
        }

        public Task<Stock?> GetStockAsync(CancellationToken ct = default)
        {
            return Task.FromResult<Stock?>(new Stock { Dimensions = new Dimensions { X = 100, Y = 100, Z = 50 }, Units = "mm" });
        }

        public Task<Wcs?> GetWcsAsync(CancellationToken ct = default)
        {
            return Task.FromResult<Wcs?>(new Wcs { Name = "WCS 1", Origin = new double[] { 0, 0, 0 }, Axes = new Dictionary<string, double[]> { ["x"] = new double[] { 1, 0, 0 }, ["y"] = new double[] { 0, 1, 0 }, ["z"] = new double[] { 0, 0, 1 } } });
        }

        public Task<IReadOnlyList<MachineGroup>> ListMachineGroupsAsync(CancellationToken ct = default)
        {
            return Task.FromResult<IReadOnlyList<MachineGroup>>(new[] { new MachineGroup { Id = "mill", Name = "Mill", Type = "mill" } });
        }

        public Task<IReadOnlyList<Tool>> ListToolsAsync(CancellationToken ct = default)
        {
            return Task.FromResult<IReadOnlyList<Tool>>(Array.Empty<Tool>());
        }

        public Task<PostProcessor?> GetPostProcessorAsync(CancellationToken ct = default)
        {
            return Task.FromResult<PostProcessor?>(new PostProcessor { Name = "default", Extension = ".nc", Machine = "mill" });
        }

        public Task<ToolpathStatus?> GetToolpathStatusAsync(int operationId, CancellationToken ct = default)
        {
            return Task.FromResult<ToolpathStatus?>(new ToolpathStatus { OperationId = operationId, Generated = false, Valid = false, Dirty = false, CollisionState = "not_checked" });
        }

        public Task<OperationParameters?> GetOperationParametersAsync(int operationId, CancellationToken ct = default)
        {
            return Task.FromResult<OperationParameters?>(new OperationParameters { OperationId = operationId });
        }

        public Task<PreviewResult> PreviewOperationParametersAsync(int operationId, Quantity? feedRate, Quantity? spindleSpeed, string? idempotencyKey, CancellationToken ct = default)
        {
            return Task.FromResult(new PreviewResult
            {
                Before = new OperationParameters { OperationId = operationId },
                After = new OperationParameters { OperationId = operationId, FeedRate = feedRate, SpindleSpeed = spindleSpeed },
                RequiresRegeneration = true,
                RollbackAvailable = true,
                ApprovalToken = Guid.NewGuid().ToString(),
                ExpiresAt = DateTime.UtcNow.AddMinutes(5).ToString("O"),
                DocumentRevision = "rev-1",
                OperationFingerprint = "unknown"
            });
        }

        public Task<ApplyResult> ApplyOperationParameterPreviewAsync(string approvalToken, string? idempotencyKey, CancellationToken ct = default)
        {
            return Task.FromResult(new ApplyResult { Applied = false, TransactionId = Guid.NewGuid().ToString(), DocumentRevision = "rev-1", OperationFingerprint = "unknown", Before = new(), After = new(), Regenerated = false, Verification = new Verification { Pass = false } });
        }

        public Task<Verification> VerifyChangeAsync(int operationId, Quantity? expectedFeedRate, Quantity? expectedSpindleSpeed, string? documentRevision, CancellationToken ct = default)
        {
            return Task.FromResult(new Verification { Pass = false, Reread = false });
        }

        public Task<ApplyResult> RollbackChangeAsync(string transactionId, string? idempotencyKey, CancellationToken ct = default)
        {
            return Task.FromResult(new ApplyResult { Applied = false, TransactionId = Guid.NewGuid().ToString(), DocumentRevision = "rev-1", OperationFingerprint = "unknown", Before = new(), After = new(), Regenerated = false, Verification = new Verification { Pass = false } });
        }

        public Task<SimulationResult> RunSimulationAsync(int[]? operationIds, string mode, bool checkCollisions, int timeoutMs, CancellationToken ct = default)
        {
            return Task.FromResult(new SimulationResult { State = "complete", DurationSeconds = 0, Collisions = Array.Empty<Collision>(), Warnings = Array.Empty<string>(), CycleTimeEstimate = 0, OperationsSimulated = 0 });
        }

        public Task<Collision[]> DetectCollisionsAsync(int[]? operationIds, bool checkHolder, bool checkRapid, bool checkWorkpiece, CancellationToken ct = default)
        {
            return Task.FromResult(Array.Empty<Collision>());
        }

        public Task<double?> EstimateCycleTimeAsync(int operationId, CancellationToken ct = default)
        {
            return Task.FromResult<double?>(0);
        }

        public Task<byte[]> CaptureViewAsync(int? operationId, string view, int width, int height, string format, bool showTool, bool showStock, bool showFixture, CancellationToken ct = default)
        {
            return Task.FromResult(Array.Empty<byte>());
        }

        public Task<bool> RegenerateToolpathAsync(int[] operationIds, bool waitForCompletion, int timeoutMs, CancellationToken ct = default)
        {
            return Task.FromResult(false);
        }

        public Task<string> GetVersionReportAsync(CancellationToken ct = default)
        {
            return Task.FromResult("{\"mastercam\":\"legacy\",\"netHook\":\"legacy\",\"supported\":[],\"liveMappingsVerified\":false,\"adapterVersion\":\"" + AdapterVersion + "\",\"protocolVersion\":2}");
        }

        public Task<MachineContext> GetMachineContextAsync(CancellationToken ct = default)
        {
            return Task.FromResult(new MachineContext
            {
                Machine = new MachineInfo { Name = "Legacy Mastercam", Type = "mill", Axes = 3 },
                Stock = new Stock { Dimensions = new Dimensions { X = 100, Y = 100, Z = 50 }, Units = "mm" },
                Workholding = new Workholding { State = "unknown", Verified = false },
                Wcs = "WCS 1",
                Safety = "not_verified"
            });
        }
    }
}