using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
// Mastercam 2027 uses .NET 10 runtime. NETHook10_0.dll provides NetHook10App.
// For API compatibility, this adapter targets net10.0-windows and references NETHook10_0.dll.
// If Mastercam 2027 SDK renames the base type, update the inheritance below.
using Mastercam.App;
using Mastercam.App.Types;
using MastercamMcp.Core;

namespace MastercamMcp.Addin
{
    public sealed class EntryPoint : NetHook3App
    {
        public override MCamReturn Run(int param)
        {
            BridgeHost.Start(PipeName());
            return MCamReturn.NoErrors;
        }

        private static string PipeName() => Environment.GetEnvironmentVariable("MASTERCAM_MCP_PIPE") ?? "mastercam-mcp-default";
    }

    internal static class BridgeHost
    {
        private const int MaxRequestBytes = 1024 * 1024;
        private static int _started;
        private static CancellationTokenSource? _cts;
        private static Task? _listenerTask;

        public static void Start(string pipeName)
        {
            if (Interlocked.Exchange(ref _started, 1) != 0) return;
            _cts = new CancellationTokenSource();
            _listenerTask = Task.Run(() => Listen(pipeName, _cts.Token));
        }

        public static void Stop()
        {
            _cts?.Cancel();
            try { _listenerTask?.Wait(TimeSpan.FromSeconds(5)); } catch { }
            _cts?.Dispose();
            _cts = null;
            Interlocked.Exchange(ref _started, 0);
        }

        private static async Task Listen(string pipeName, CancellationToken ct)
        {
            pipeName = NormalizePipeName(pipeName);
            var router = new RequestRouter();

            while (!ct.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, PipeSecurity());
                    await server.WaitForConnectionAsync(ct);

                    using var reader = new StreamReader(server, Encoding.UTF8, false, 4096, true);
                    using var writer = new StreamWriter(server, new UTF8Encoding(false), 4096, true) { AutoFlush = true };

                    var requestLine = await reader.ReadLineAsync();
                    if (requestLine == null) continue;

                    if (Encoding.UTF8.GetByteCount(requestLine) > MaxRequestBytes)
                    {
                        await writer.WriteLineAsync(JsonSerializer.Serialize(new { id = (string?)null, result = new { ok = false, error = new { code = "REQUEST_TOO_LARGE", message = "Request exceeds 1 MiB" } } }));
                        continue;
                    }

                    var response = await router.DispatchAsync(requestLine, ct);
                    await writer.WriteLineAsync(response);
                }
                catch (OperationCanceledException) { break; }
                catch (Exception ex)
                {
                    Log(ex);
                    try { await Task.Delay(250, ct); } catch { break; }
                }
            }
        }

        private static void Log(Exception ex)
        {
            try
            {
                var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mastercam-mcp");
                Directory.CreateDirectory(directory);
                File.AppendAllText(Path.Combine(directory, "native.log"), DateTime.UtcNow.ToString("O") + " " + ex + Environment.NewLine);
            }
            catch { }
        }

        private static string NormalizePipeName(string value)
        {
            const string prefix = @"\\.\pipe\";
            return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? value.Substring(prefix.Length) : value;
        }

        private static PipeSecurity PipeSecurity()
        {
            var security = new PipeSecurity();
            var identity = WindowsIdentity.GetCurrent().User;
            if (identity != null) security.AddAccessRule(new PipeAccessRule(identity, PipeAccessRights.FullControl, AccessControlType.Allow));
            return security;
        }
    }
}
