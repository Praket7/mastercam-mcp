using System.Reflection;
using System.Text.Json;

var roots = args.Length == 0 ? new[] { Environment.GetEnvironmentVariable("MASTERCAM_ROOT") ?? "" } : args;
var wanted = new[] { "NETHook3_0.dll", "ToolNetApi.dll", "SimAccessManaged.dll" };
var assemblies = new List<object>();
foreach (var root in roots.Where(Directory.Exists))
foreach (var file in wanted.Select(name => Path.Combine(root, name)).Where(File.Exists))
{
    try
    {
        var asm = Assembly.LoadFrom(file);
        var types = asm.GetTypes().Select(t => new {
            @namespace = t.Namespace, type = t.FullName,
            properties = t.GetProperties().Select(p => new { name = p.Name, type = p.PropertyType.FullName }),
            methods = t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly).Select(m => new {
                name = m.Name, returnType = m.ReturnType.FullName,
                parameters = m.GetParameters().Select(p => new { name = p.Name, type = p.ParameterType.FullName })
            }),
            enumValues = t.IsEnum ? Enum.GetNames(t) : Array.Empty<string>()
        });
        assemblies.Add(new { file = Path.GetFileName(file), version = asm.GetName().Version?.ToString(), types });
    }
    catch (Exception ex) { assemblies.Add(new { file = Path.GetFileName(file), error = ex.GetType().Name }); }
}
var output = JsonSerializer.Serialize(new { generatedAt = DateTimeOffset.UtcNow, proprietaryFilesRemainLocal = true, assemblies }, new JsonSerializerOptions { WriteIndented = true });
var destination = Environment.GetEnvironmentVariable("MASTERCAM_API_INDEX_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mastercam-mcp", "api-indexes");
Directory.CreateDirectory(destination);
File.WriteAllText(Path.Combine(destination, "index.json"), output);
Console.WriteLine($"Wrote local catalog to {destination}");
