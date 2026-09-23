using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using MastercamMcp.Adapter.Abstractions;

namespace MastercamMcp.Addin.2027
{
    /// <summary>
    /// Mastercam 2027 adapter. Stage A environment reporting is always
    /// available. Stage-B read-only programming-context extraction is opt-in
    /// and runtime-probed; it never promotes itself to LIVE_READ_VERIFIED.
    /// </summary>
    internal sealed class EnvironmentAdapter : IMastercamAdapter
    {
        public const string AdapterVersionValue = "0.2.0-2027-stage-b";

        private static readonly string[] StageBReadTools =
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

        public AdapterInfo Info
        {
            get
            {
                return new AdapterInfo
                {
                    AdapterVersion = AdapterVersionValue,
                    MastercamVersion = DetectMastercamVersion(),
                    Runtime = "net10.0-windows",
                    ProtocolVersion = 2
                };
            }
        }

        public IReadOnlyList<Capability> Capabilities()
        {
            var probe = ProgrammingContextReader.Probe();
            var stageBEnabled = ProgrammingContextReader.Enabled;
            var stageBSupported = stageBEnabled && probe.CanReadProgrammingContext;
            var stageBReason = !stageBEnabled
                ? "runtime probe available but Stage-B reads are disabled; set MASTERCAM_MCP_ENABLE_STAGE_B_READS=1 on a licensed acceptance workstation"
                : probe.CanReadProgrammingContext
                    ? "SearchManager.GetOperations() resolved at runtime; mapping is IMPLEMENTED but not live-read verified"
                    : string.Join(" ", probe.Notes);

            var capabilities = new List<Capability>
            {
                new Capability
                {
                    Name = "mastercam_status",
                    Supported = true,
                    RiskClass = RiskClass.Read,
                    Tier = CapabilityTier.Implemented,
                    MappingVersion = 1,
                    Reason = "environment reporting; live acceptance run pending"
                },
                new Capability
                {
                    Name = "mastercam_capabilities",
                    Supported = true,
                    RiskClass = RiskClass.Read,
                    Tier = CapabilityTier.Implemented,
                    MappingVersion = 1,
                    Reason = "environment reporting; live acceptance run pending"
                },
            };

            foreach (var name in StageBReadTools)
            {
                capabilities.Add(new Capability
                {
                    Name = name,
                    Supported = stageBSupported,
                    RiskClass = RiskClass.Read,
                    Tier = probe.CanReadProgrammingContext ? CapabilityTier.Implemented : CapabilityTier.Discovered,
                    RequiresActiveDocument = true,
                    MappingVersion = 1,
                    Reason = stageBReason
                });
            }

            return capabilities;
        }

        public AdapterResult Invoke(
            string tool,
            string argumentsJson,
            string requestId,
            System.Threading.CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var info = this.Info;

            if (tool == "mastercam_status")
            {
                var probe = ProgrammingContextReader.Probe();
                return AdapterResult.Success(new
                {
                    connected = true,
                    backend = "mastercam-net-hook",
                    adapter = info.AdapterVersion,
                    runtime = info.Runtime,
                    mastercamVersion = info.MastercamVersion,
                    protocolVersion = info.ProtocolVersion,
                    stageBReadsEnabled = ProgrammingContextReader.Enabled,
                    stageBProgrammingContextProbe = new
                    {
                        searchManagerFound = probe.SearchManagerFound,
                        getOperationsFound = probe.GetOperationsFound,
                        searchManagerAssembly = probe.SearchManagerAssembly,
                        getOperationsReturnType = probe.GetOperationsReturnType,
                        notes = probe.Notes
                    }
                });
            }

            if (tool == "mastercam_capabilities")
            {
                var declared = new List<object>();
                foreach (var capability in this.Capabilities())
                {
                    declared.Add(new
                    {
                        name = capability.Name,
                        supported = capability.Supported,
                        riskClass = capability.RiskClass.ToString().ToLowerInvariant(),
                        tier = capability.Tier.ToString(),
                        mappingVersion = capability.MappingVersion,
                        reason = capability.Reason
                    });
                }
                return AdapterResult.Success(new
                {
                    adapterVersion = info.AdapterVersion,
                    mastercamVersion = info.MastercamVersion,
                    runtime = info.Runtime,
                    protocol = "bridge-v2",
                    tools = declared,
                    note = ProgrammingContextReader.Enabled
                        ? "Stage-B read-only context extraction is enabled. It remains IMPLEMENTED, not LIVE_READ_VERIFIED, until a licensed acceptance report passes."
                        : "Stage A environment reporting is active. Stage-B read-only context extraction is installed but disabled pending licensed acceptance."
                });
            }

            if (ProgrammingContextTools.CanHandle(tool))
            {
                return ProgrammingContextTools.Invoke(tool, argumentsJson, cancellationToken);
            }

            return AdapterResult.Failure(
                "UNSUPPORTED_CAPABILITY",
                "This live Mastercam tool has no verified or explicitly enabled Stage-B mapping on the installed release");
        }

        /// <summary>
        /// Derives the marketing release from the Mastercam host executable
        /// (major 26 -> 2026). Falls back to "unknown" rather than guessing.
        /// </summary>
        public static string DetectMastercamVersion()
        {
            try
            {
                var entry = System.Reflection.Assembly.GetEntryAssembly();
                if (entry == null || string.IsNullOrEmpty(entry.Location)) return "unknown";
                var version = FileVersionInfo.GetVersionInfo(entry.Location);
                var major = version.FileMajorPart;
                if (major >= 20 && major <= 40) return (2000 + major).ToString();
                return version.ProductVersion ?? "unknown";
            }
            catch
            {
                return "unknown";
            }
        }
    }
}
