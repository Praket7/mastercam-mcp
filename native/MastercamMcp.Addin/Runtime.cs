using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;

namespace MastercamMcp.Addin
{
    internal static class Runtime
    {
        public static string Dispatch(string json)
        {
            var request = JsonDocument.Parse(json).RootElement;
            var tool = request.GetProperty("tool").GetString() ?? "";
            var result = new Dictionary<string, object> { ["ok"] = true, ["tool"] = tool, ["live"] = true };
            if (tool == "mastercam_status") result["data"] = new { connected = true, adapter = "NET Hook" };
            else if (tool == "mastercam_capabilities") result["data"] = CatalogCapabilities();
            else result["data"] = new { status = "adapter requires verified local API mapping", tool };
            return JsonSerializer.Serialize(new { id = request.GetProperty("id").GetString(), result });
        }

        private static object CatalogCapabilities()
        {
            var names = new List<string>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                if (assembly.FullName != null && assembly.FullName.IndexOf("Mastercam", StringComparison.OrdinalIgnoreCase) >= 0) names.Add(assembly.GetName().Name ?? "unknown");
            return new { assemblies = names, note = "Only locally loaded APIs are reported" };
        }
    }
}
