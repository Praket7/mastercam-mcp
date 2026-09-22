using System.Collections.Generic;

namespace MastercamMcp.Adapter.Abstractions
{
    /// <summary>Verification tiers; never advertise above what live testing proved (audit section 66).</summary>
    public enum CapabilityTier
    {
        Unavailable = 0,
        Discovered = 1,
        Implemented = 2,
        LiveReadVerified = 3,
        LiveWriteVerified = 4
    }

    public enum RiskClass
    {
        Read = 0,
        Mutation = 1,
        Advanced = 2
    }

    /// <summary>One capability exposed by an adapter (audit section 21).</summary>
    public sealed class Capability
    {
        public string Name { get; set; }
        public bool Supported { get; set; }
        public RiskClass RiskClass { get; set; }
        public CapabilityTier Tier { get; set; }
        public bool RequiresActiveDocument { get; set; }
        public bool RequiresRegeneration { get; set; }
        public int MappingVersion { get; set; }
        public string Reason { get; set; }
    }

    /// <summary>Identity of the running adapter for status and doctor output.</summary>
    public sealed class AdapterInfo
    {
        public string AdapterVersion { get; set; }
        public string MastercamVersion { get; set; }
        public string Runtime { get; set; }
        public int ProtocolVersion { get; set; }
    }

    /// <summary>
    /// Result envelope returned by adapter invocations; adapters never throw
    /// across this boundary, they return typed failures (audit section 31).
    /// </summary>
    public sealed class AdapterResult
    {
        public bool Ok { get; set; }
        public object Data { get; set; }
        public string ErrorCode { get; set; }
        public string ErrorMessage { get; set; }
        public bool Retryable { get; set; }
        public object Receipt { get; set; }
        public string DocumentRevision { get; set; }

        public static AdapterResult Success(object data, string documentRevision = null)
        {
            return new AdapterResult { Ok = true, Data = data, DocumentRevision = documentRevision };
        }

        public static AdapterResult Failure(string code, string message, bool retryable = false)
        {
            return new AdapterResult { Ok = false, ErrorCode = code, ErrorMessage = message, Retryable = retryable };
        }
    }

    /// <summary>
    /// Every Mastercam release gets its own adapter implementation. The bridge
    /// host talks only to this interface, never to Mastercam APIs directly
    /// (audit SAFE-02, COMPAT-02).
    /// </summary>
    public interface IMastercamAdapter
    {
        AdapterInfo Info { get; }

        /// <summary>Capabilities this adapter genuinely implements, for the registry.</summary>
        IReadOnlyList<Capability> Capabilities();

        /// <summary>
        /// Executes a tool. Implementations must marshal to Mastercam's own
        /// threading model where required (audit SAFE-02) and honor
        /// cancellation only at safe boundaries.
        /// </summary>
        AdapterResult Invoke(string tool, string argumentsJson, string requestId, System.Threading.CancellationToken cancellationToken);
    }
}
