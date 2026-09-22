using System;
using System.Collections.Generic;
using System.Linq;
using MastercamMcp.Adapter.Abstractions;

namespace MastercamMcp.Core
{
    /// <summary>
    /// Holds the adapter-declared capability set. The registry is the only
    /// source the router consults, so a tool that is not declared as supported
    /// can never reach Mastercam code (audit P0-01/21).
    /// </summary>
    public sealed class CapabilityRegistry
    {
        private readonly Dictionary<string, Capability> capabilities;
        private static readonly HashSet<string> KnownReadTools = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "mastercam_status", "mastercam_capabilities", "get_active_part", "list_operations", "get_operation",
            "find_operations", "explain_operation", "get_operation_risks", "get_operation_parameters", "get_stock",
            "get_wcs", "list_tools", "get_machine_context", "get_programming_context", "get_version_report"
        };

        public CapabilityRegistry(IMastercamAdapter adapter)
        {
            this.capabilities = new Dictionary<string, Capability>(StringComparer.OrdinalIgnoreCase);
            if (adapter == null) return;
            foreach (var capability in adapter.Capabilities())
            {
                this.capabilities[capability.Name] = capability;
            }
        }

        public Capability Find(string tool)
        {
            Capability capability;
            return this.capabilities.TryGetValue(tool ?? string.Empty, out capability) ? capability : null;
        }

        public bool IsRead(string tool)
        {
            return KnownReadTools.Contains(tool ?? string.Empty);
        }

        public int SupportedCount
        {
            get { return this.capabilities.Values.Count(capability => capability.Supported); }
        }

        public int UnsupportedCount
        {
            get { return this.capabilities.Values.Count(capability => !capability.Supported); }
        }

        public IReadOnlyList<Capability> All
        {
            get { return this.capabilities.Values.ToList(); }
        }
    }
}
