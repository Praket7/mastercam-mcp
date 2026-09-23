using System.Reflection;
using System.Threading;
using MastercamMcp.ReadModel;

namespace MastercamMcp.Addin.2027
{
    /// <summary>
    /// Stage-B read-only extractor. It invokes only the public, zero-argument
    /// SearchManager.GetOperations contract that is evidenced by public
    /// NET-Hook examples. Per-operation fields are reflected conservatively
    /// into bounded primitive/value records; unknown members remain unknown.
    /// </summary>
    internal static class ProgrammingContextReader
    {
        public const int MaxOperations = 5000;

        public static bool Enabled =>
            string.Equals(
                Environment.GetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS"),
                "1",
                StringComparison.OrdinalIgnoreCase) ||
            string.Equals(
                Environment.GetEnvironmentVariable("MASTERCAM_MCP_ENABLE_STAGE_B_READS"),
                "true",
                StringComparison.OrdinalIgnoreCase);

        public static RuntimeProbe Probe()
        {
            return SafeReflection.ProbeLoadedAssemblies(AppDomain.CurrentDomain.GetAssemblies());
        }

        public static bool TryRead(
            CancellationToken cancellationToken,
            out ProgrammingSnapshot? snapshot,
            out string? errorCode,
            out string? errorMessage)
        {
            snapshot = null;
            errorCode = null;
            errorMessage = null;

            if (!Enabled)
            {
                errorCode = "CAPABILITY_UNAVAILABLE";
                errorMessage = "Stage-B live reads are disabled. Set MASTERCAM_MCP_ENABLE_STAGE_B_READS=1 only on a licensed Mastercam 2027 acceptance workstation.";
                return false;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var probe = Probe();
            if (!probe.CanReadProgrammingContext)
            {
                errorCode = "MAPPING_INCOMPLETE";
                errorMessage = string.Join(" ", probe.Notes);
                return false;
            }

            Type? searchManager = null;
            Assembly? owner = null;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var candidate = assembly.GetType(
                        "Mastercam.Support.SearchManager",
                        throwOnError: false,
                        ignoreCase: false);
                    if (candidate == null) continue;
                    searchManager = candidate;
                    owner = assembly;
                    break;
                }
                catch
                {
                    // Keep looking; one partially loaded vendor assembly must not
                    // make every read capability unavailable.
                }
            }

            if (searchManager == null)
            {
                errorCode = "MAPPING_INCOMPLETE";
                errorMessage = "Mastercam.Support.SearchManager could not be resolved from the loaded Mastercam assemblies.";
                return false;
            }

            var method = searchManager.GetMethod(
                "GetOperations",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null);
            if (method == null)
            {
                errorCode = "MAPPING_INCOMPLETE";
                errorMessage = "SearchManager.GetOperations() was not found as a public static zero-argument method.";
                return false;
            }

            object? raw;
            try
            {
                raw = method.Invoke(null, null);
            }
            catch (TargetInvocationException ex)
            {
                errorCode = "MASTER_CAM_API_ERROR";
                errorMessage = ex.InnerException?.Message ?? ex.Message;
                return false;
            }
            catch (Exception ex)
            {
                errorCode = "MASTER_CAM_API_ERROR";
                errorMessage = ex.Message;
                return false;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var operations = SafeReflection.EnumerateBounded(raw, MaxOperations).ToList();
            snapshot = SafeReflection.BuildProgrammingSnapshot(
                operations,
                $"{searchManager.FullName}.{method.Name}",
                MaxOperations);
            snapshot.Source = "mastercam-2027-net-hook-stage-b";
            snapshot.Evidence.Add(new SnapshotEvidence
            {
                Source = owner?.GetName().Name ?? "unknown",
                Member = $"{searchManager.FullName}.{method.Name}",
                Note = $"Return type: {method.ReturnType.FullName ?? method.ReturnType.Name}; runtime reflection prevents compile-time assumptions about per-operation members."
            });
            return true;
        }
    }
}
