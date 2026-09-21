using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using MastercamMcp.Adapter.Abstractions;

namespace MastercamMcp.Addin
{
    /// <summary>
    /// Stage A adapter (audit section 22): environment reporting only. It
    /// declares exactly two capabilities and nothing else, so the router
    /// answers UNSUPPORTED_CAPABILITY for every inspection or mutation tool
    /// until a release-specific adapter is live-verified (P0-01: mock-tested
    /// functionality must never present itself as live functionality).
    /// </summary>
    internal sealed class EnvironmentAdapter : IMastercamAdapter
    {
        public const string AdapterVersionValue = "0.2.0-2027";

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
            return new List<Capability>
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
                }
            };
        }

        public AdapterResult Invoke(string tool, string argumentsJson, string requestId, System.Threading.CancellationToken cancellationToken)
        {
            var info = this.Info;
            if (tool == "mastercam_status")
            {
                return AdapterResult.Success(new
                {
                    connected = true,
                    backend = "mastercam-net-hook",
                    adapter = info.AdapterVersion,
                    runtime = info.Runtime,
                    mastercamVersion = info.MastercamVersion,
                    protocolVersion = info.ProtocolVersion
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
                    note = "Only environment reporting is live. Inspection and mutation mappings are added per release after licensed live verification."
                });
            }
            // Unreachable through the router (registry gates), but never invent behavior here.
            return AdapterResult.Failure("UNSUPPORTED_CAPABILITY", "This live Mastercam tool has no verified mapping on the installed release");
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
