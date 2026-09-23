using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

// PERF-03: discover all resolver paths once and build ONE MetadataLoadContext
// instead of constructing a new load context per target assembly.
var roots = args.Length == 0 ? new[] { Environment.GetEnvironmentVariable("MASTERCAM_ROOT") ?? "" } : args;
var fixedTargets = new[] { "ToolNetApi.dll", "SimAccessManaged.dll" };

var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var frameworkReferenceDirectory = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
    ".nuget", "packages", "microsoft.netframework.referenceassemblies.net48");

var resolverPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
foreach (var root in roots.Where(Directory.Exists))
{
    foreach (var file in Directory.EnumerateFiles(root, "*.dll"))
    {
        resolverPaths.Add(file);
    }
}
foreach (var file in Directory.EnumerateFiles(runtimeDirectory, "*.dll"))
{
    resolverPaths.Add(file);
}
if (Directory.Exists(frameworkReferenceDirectory))
{
    foreach (var file in Directory.EnumerateFiles(frameworkReferenceDirectory, "*.dll", SearchOption.AllDirectories))
    {
        resolverPaths.Add(file);
    }
}

var assemblies = new List<object>();
var loaderExceptions = new List<string>();
var targetFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
foreach (var root in roots.Where(Directory.Exists))
{
    foreach (var file in Directory.EnumerateFiles(root, "NETHook*.dll"))
        targetFiles.Add(file);
    foreach (var name in fixedTargets)
    {
        var file = Path.Combine(root, name);
        if (File.Exists(file)) targetFiles.Add(file);
    }
}

if (resolverPaths.Count > 0)
{
    using var loadContext = new MetadataLoadContext(new PathAssemblyResolver(resolverPaths), typeof(object).Assembly.GetName().Name);
    foreach (var file in targetFiles.OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
    {
        try
        {
            var asm = loadContext.LoadFromAssemblyPath(file);
            Type[] types;
            try
            {
                types = asm.GetTypes();
            }
            // BUG-12: partial type loads must not discard the whole assembly.
            catch (ReflectionTypeLoadException ex)
            {
                types = ex.Types.Where(t => t != null).ToArray()!;
                foreach (var loaderException in ex.LoaderExceptions)
                {
                    loaderExceptions.Add($"{Path.GetFileName(file)}: {loaderException?.Message}");
                }
            }
            var versionInfo = FileVersionInfo.GetVersionInfo(file);
            var typePayload = types.Select(t => new
            {
                @namespace = t.Namespace,
                type = t.FullName,
                properties = t.GetProperties().Select(p => new { name = p.Name, type = p.PropertyType.FullName }).ToArray(),
                methods = t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly).Select(m => new
                {
                    name = m.Name,
                    returnType = m.ReturnType.FullName,
                    parameters = m.GetParameters().Select(p => new { name = p.Name, type = p.ParameterType.FullName }).ToArray()
                }).ToArray(),
                enumValues = t.IsEnum ? Enum.GetNames(t) : Array.Empty<string>()
            }).ToArray();
            assemblies.Add(new
            {
                file = Path.GetFileName(file),
                version = asm.GetName().Version?.ToString(),
                fileVersion = versionInfo.FileVersion,
                assemblyHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))),
                typePayload
            });
        }
        catch (Exception ex)
        {
            assemblies.Add(new { file = Path.GetFileName(file), error = ex.GetType().Name, message = ex.Message });
        }
    }
}

var output = JsonSerializer.Serialize(
    new
    {
        generatedAt = DateTimeOffset.UtcNow,
        proprietaryFilesRemainLocal = true,
        catalogSchemaVersion = 2,
        loaderExceptions,
        assemblies,
        stageBDiscovery = new
        {
            nethookAssemblies = targetFiles
                .Select(Path.GetFileName)
                .Where(name => name != null && name.StartsWith("NETHook", StringComparison.OrdinalIgnoreCase))
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                .ToArray(),
            requiredOperationContract = "Mastercam.Support.SearchManager.GetOperations()",
            note = "The catalog records local SDK shapes only; it does not promote any capability to LIVE_READ_VERIFIED."
        }
    },
    new JsonSerializerOptions { WriteIndented = true });

var destination = Environment.GetEnvironmentVariable("MASTERCAM_API_INDEX_DIR")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mastercam-mcp", "api-indexes");
Directory.CreateDirectory(destination);
File.WriteAllText(Path.Combine(destination, "index.json"), output);
Console.WriteLine($"Wrote local catalog to {destination}");
