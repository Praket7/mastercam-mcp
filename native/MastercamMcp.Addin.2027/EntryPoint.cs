using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
// Mastercam 2027 uses the NETHook10_0 assembly. The concrete base-class
// compatibility is intentionally reported as IMPLEMENTED until licensed load
// acceptance confirms the target Mastercam build.
using Mastercam.App;
using Mastercam.App.Types;
using MastercamMcp.Core;
using MastercamMcp.Protocol;

namespace MastercamMcp.Addin.V2027
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
            using var router = new RequestRouter(new EnvironmentAdapter(), "2027");

            while (!ct.IsCancellationRequested)
            {
                NamedPipeServerStream? server = null;
                try
                {
                    server = new NamedPipeServerStream(
                        pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous, 32 * 1024, 32 * 1024, PipeSecurity());
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
                    router.CancelAll();
                    try { server?.Dispose(); } catch { }
                }
            }
        }

        private static async Task HandleConnectionAsync(NamedPipeServerStream pipe, RequestRouter router, CancellationToken ct)
        {
            var buffer = new byte[32 * 1024];
            using var pending = new PooledFrameBuffer(32 * 1024);
            var responseTasks = new List<Task>();
            using var writeLock = new SemaphoreSlim(1, 1);

            try
            {
                while (!ct.IsCancellationRequested && pipe.IsConnected)
                {
                    int read;
                    try { read = await pipe.ReadAsync(buffer, 0, buffer.Length, ct); }
                    catch { break; }
                    if (read == 0) break;

                    pending.Append(buffer, 0, read);
                    while (true)
                    {
                        string json;
                        try
                        {
                            if (!pending.TryReadUtf8Frame(out json)) break;
                        }
                        catch (Exception ex)
                        {
                            Log(ex);
                            return;
                        }

                        var outcome = router.Handle(json);
                        if (outcome.IsCancel) continue;

                        if (outcome.ImmediateResponse != null)
                        {
                            await WriteRawResponseAsync(pipe, outcome.ImmediateResponse, writeLock, ct);
                        }
                        else if (outcome.Pending != null)
                        {
                            responseTasks.Add(WritePendingResponseAsync(pipe, outcome.Pending, writeLock, ct));
                            responseTasks.RemoveAll(task => task.IsCompleted);
                        }
                    }
                }
            }
            finally
            {
                router.CancelAll();
                try { await Task.WhenAll(responseTasks.ToArray()); } catch { }
            }
        }

        private static async Task WritePendingResponseAsync(
            NamedPipeServerStream pipe,
            Task<BridgeResponse> responseTask,
            SemaphoreSlim writeLock,
            CancellationToken ct)
        {
            try
            {
                var response = await responseTask.ConfigureAwait(false);
                var frame = FrameCodec.EncodeFrame(FrameSerializer.Serialize(response));
                await WriteFrameAsync(pipe, frame, writeLock, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log(ex); }
        }

        private static async Task WriteRawResponseAsync(
            NamedPipeServerStream pipe,
            string response,
            SemaphoreSlim writeLock,
            CancellationToken ct)
        {
            var frame = FrameCodec.EncodeFrame(Encoding.UTF8.GetBytes(response));
            await WriteFrameAsync(pipe, frame, writeLock, ct).ConfigureAwait(false);
        }

        private static async Task WriteFrameAsync(
            NamedPipeServerStream pipe,
            byte[] frame,
            SemaphoreSlim writeLock,
            CancellationToken ct)
        {
            if (!pipe.IsConnected) return;
            await writeLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (!pipe.IsConnected) return;
                await pipe.WriteAsync(frame, 0, frame.Length, ct).ConfigureAwait(false);
            }
            finally
            {
                writeLock.Release();
            }
        }

        private static void Log(Exception ex)
        {
            try
            {
                var directory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "mastercam-mcp");
                Directory.CreateDirectory(directory);
                File.AppendAllText(
                    Path.Combine(directory, "native.log"),
                    DateTime.UtcNow.ToString("O") + " " + ex + Environment.NewLine);
            }
            catch { }
        }

        private static string NormalizePipeName(string value)
        {
            const string prefix = @"\\.\pipe\";
            return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? value.Substring(prefix.Length)
                : value;
        }

        private static PipeSecurity PipeSecurity()
        {
            var security = new PipeSecurity();
            var identity = WindowsIdentity.GetCurrent().User;
            if (identity != null)
                security.AddAccessRule(new PipeAccessRule(identity, PipeAccessRights.FullControl, AccessControlType.Allow));
            return security;
        }
    }
}
