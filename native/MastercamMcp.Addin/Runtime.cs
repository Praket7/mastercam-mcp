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
            Dictionary<string, object> request;
            try
            {
                request = serializer.DeserializeObject(json) as Dictionary<string, object>;
            }
            catch (Exception ex)
            {
                return serializer.Serialize(new { id = (string)null, result = new { ok = false, error = new { code = "INVALID_JSON", message = ex.Message } } });
            }
            if (request == null) return serializer.Serialize(new { id = (string)null, result = new { ok = false, error = new { code = "INVALID_REQUEST", message = "A JSON object is required" } } });
            var tool = request != null && request.TryGetValue("tool", out var toolValue) ? Convert.ToString(toolValue) ?? "" : "";
            var id = request.TryGetValue("id", out var idValue) ? Convert.ToString(idValue) : null;
            if (tool == "mastercam_status") return serializer.Serialize(new { id, result = new { ok = true, tool, live = true, data = new { connected = true, adapter = "NET Hook" } } });
            if (tool == "mastercam_capabilities") return serializer.Serialize(new { id, result = new { ok = true, tool, live = true, data = CatalogCapabilities() } });
            return serializer.Serialize(new { id, result = new { ok = false, tool, live = false, error = new { code = "UNSUPPORTED_CAPABILITY", message = "This live Mastercam tool has no verified NET Hook mapping yet" } } });
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
