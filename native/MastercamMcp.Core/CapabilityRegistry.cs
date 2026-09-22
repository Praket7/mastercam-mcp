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
            var capability = Find(tool);
            return capability != null && capability.RiskClass == RiskClass.Read;
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
