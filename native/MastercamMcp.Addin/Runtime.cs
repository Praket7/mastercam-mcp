using System;
using System.Collections.Generic;
using System.Reflection;
using System.Web.Script.Serialization;

namespace MastercamMcp.Addin
{
    internal static class Runtime
    {
        public static string Dispatch(string json)
        {
            var serializer = new JavaScriptSerializer();
            var request = serializer.DeserializeObject(json) as Dictionary<string, object>;
            var tool = request != null && request.TryGetValue("tool", out var toolValue) ? Convert.ToString(toolValue) ?? "" : "";
            var result = new Dictionary<string, object> { ["ok"] = true, ["tool"] = tool, ["live"] = true };
            if (tool == "mastercam_status") result["data"] = new { connected = true, adapter = "NET Hook" };
            else if (tool == "mastercam_capabilities") result["data"] = CatalogCapabilities();
            else result["data"] = new { status = "adapter requires verified local API mapping", tool };
            var id = request != null && request.TryGetValue("id", out var idValue) ? Convert.ToString(idValue) : null;
            return serializer.Serialize(new { id, result });
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
