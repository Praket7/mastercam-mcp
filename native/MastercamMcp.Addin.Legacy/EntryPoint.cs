using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using Mastercam.App;
using Mastercam.App.Types;
using MastercamMcp.Core;
using MastercamMcp.Protocol;

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
        private const int MaxFrameBytes = 16 * 1024 * 1024;
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
            var router = new RequestRouter(new EnvironmentAdapter(), "2026");

            while (!ct.IsCancellationRequested)
            {
                NamedPipeServerStream? server = null;
                try
                {
                    server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, PipeSecurity());
                    await server.WaitForConnectionAsync(ct);
                    await HandleConnectionAsync(server, router, ct);
                }
                catch (OperationCanceledException) { break; }
                catch (Exception ex)
                {
                    Log(ex);
                    try { await Task.Delay(500, ct); } catch { break; }
                }
                finally
                {
                    try { server?.Dispose(); } catch { }
                }
            }
            router.Dispose();
        }

        private static async Task HandleConnectionAsync(NamedPipeServerStream pipe, RequestRouter router, CancellationToken ct)
        {
            var buffer = new byte[8192];
            var pending = new System.Collections.Generic.List<byte>();
            while (!ct.IsCancellationRequested && pipe.IsConnected)
            {
                int read;
                try { read = await pipe.ReadAsync(buffer, 0, buffer.Length, ct); } catch { break; }
                if (read == 0) break;
                for (int i = 0; i < read; i++) pending.Add(buffer[i]);

                while (pending.Count >= 8)
                {
                    var len = BitConverter.ToInt64(pending.ToArray(), 0);
                    if (len < 0 || len > MaxFrameBytes) { pending.Clear(); break; }
                    if (pending.Count < 8 + len) break;
                    var payload = pending.GetRange(8, (int)len).ToArray();
                    pending.RemoveRange(0, 8 + (int)len);
                    var json = Encoding.UTF8.GetString(payload);
                    var outcome = router.Handle(json);
                    if (outcome.IsCancel) continue;
                    if (outcome.ImmediateResponse != null)
                    {
                        var respBytes = Encoding.UTF8.GetBytes(outcome.ImmediateResponse);
                        var frame = FrameCodec.EncodeFrame(respBytes);
                        await pipe.WriteAsync(frame, 0, frame.Length, ct);
                        await pipe.FlushAsync(ct);
                    }
                    else if (outcome.Pending != null)
                    {
                        var resp = await outcome.Pending;
                        var respJson = JsonSerializer.Serialize(resp);
                        var respBytes = Encoding.UTF8.GetBytes(respJson);
                        var frame = FrameCodec.EncodeFrame(respBytes);
                        await pipe.WriteAsync(frame, 0, frame.Length, ct);
                        await pipe.FlushAsync(ct);
                    }
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
