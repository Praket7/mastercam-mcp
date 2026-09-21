using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

var roots = args.Length == 0 ? new[] { Environment.GetEnvironmentVariable("MASTERCAM_ROOT") ?? "" } : args;
var wanted = new[] { "NETHook3_0.dll", "ToolNetApi.dll", "SimAccessManaged.dll", "NETHook10_0.dll" };
var assemblies = new List<object>();
var loadContexts = new List<MetadataLoadContext>();

try
{
    foreach (var root in roots.Where(Directory.Exists))
    {
        var resolverPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in wanted.Select(name => Path.Combine(root, name)).Where(File.Exists))
        {
            resolverPaths.Add(Path.GetDirectoryName(file)!);
        }
        foreach (var dll in Directory.EnumerateFiles(root, "*.dll", SearchOption.AllDirectories))
        {
            resolverPaths.Add(Path.GetDirectoryName(dll)!);
        }
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        foreach (var dll in Directory.EnumerateFiles(runtimeDirectory, "*.dll"))
        {
            resolverPaths.Add(Path.GetDirectoryName(dll)!);
        }
        var frameworkReferenceDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages", "microsoft.netframework.referenceassemblies.net48");
        if (Directory.Exists(frameworkReferenceDirectory))
        {
            foreach (var dll in Directory.EnumerateFiles(frameworkReferenceDirectory, "*.dll", SearchOption.AllDirectories))
            {
                resolverPaths.Add(Path.GetDirectoryName(dll)!);
            }
        }

        var loadContext = new MetadataLoadContext(new PathAssemblyResolver(resolverPaths), typeof(object).Assembly.GetName().Name);
        loadContexts.Add(loadContext);

        foreach (var file in wanted.Select(name => Path.Combine(root, name)).Where(File.Exists))
        {
            try
            {
                var asm = loadContext.LoadFromAssemblyPath(file);
                var types = new List<object>();
                try
                {
                    foreach (var t in asm.GetTypes())
                    {
                        types.Add(new
                        {
                            @namespace = t.Namespace,
                            type = t.FullName,
                            properties = t.GetProperties().Select(p => new { name = p.Name, type = p.PropertyType.FullName }).ToArray(),
                            methods = t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly).Select(m => new
                            {
                                name = m.Name,
                                returnType = m.ReturnType.FullName,
                                parameters = m.GetParameters().Select(p => new { name = p.Name, type = p.ParameterType.FullName })
                            }).ToArray(),
                            enumValues = t.IsEnum ? Enum.GetNames(t) : Array.Empty<string>()
                        });
                    }
                }
                catch (ReflectionTypeLoadException rtle)
                {
                    foreach (var t in rtle.Types.Where(t => t != null))
                    {
                        try
                        {
                            types.Add(new
                            {
                                @namespace = t!.Namespace,
                                type = t.FullName,
                                properties = t.GetProperties().Select(p => new { name = p.Name, type = p.PropertyType.FullName }).ToArray(),
                                methods = t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly).Select(m => new
                                {
                                    name = m.Name,
                                    returnType = m.ReturnType.FullName,
                                    parameters = m.GetParameters().Select(p => new { name = p.Name, type = p.ParameterType.FullName })
                                }).ToArray(),
                                enumValues = t.IsEnum ? Enum.GetNames(t) : Array.Empty<string>()
                            });
                        }
                        catch { }
                    }
                    foreach (var loaderEx in rtle.LoaderExceptions)
                    {
                        Console.Error.WriteLine($"Loader exception for {file}: {loaderEx.Message}");
                    }
                }

                assemblies.Add(new { file = Path.GetFileName(file), version = asm.GetName().Version?.ToString(), types });
            }
            catch (Exception ex)
            {
                assemblies.Add(new { file = Path.GetFileName(file), error = ex.GetType().Name, message = ex.Message });
            }
        }
    }
}
finally
{
    foreach (var loadContext in loadContexts)
    {
        try { loadContext.Dispose(); } catch { }
    }
}

var output = JsonSerializer.Serialize(new { generatedAt = DateTimeOffset.UtcNow, proprietaryFilesRemainLocal = true, assemblies }, new JsonSerializerOptions { WriteIndented = true });
var destination = Environment.GetEnvironmentVariable("MASTERCAM_API_INDEX_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mastercam-mcp", "api-indexes");
Directory.CreateDirectory(destination);
File.WriteAllText(Path.Combine(destination, "index.json"), output);
Console.WriteLine($"Wrote local catalog to {destination}");