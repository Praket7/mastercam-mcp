using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using Mastercam.App;
using Mastercam.App.Types;

namespace MastercamMcp.Addin.Legacy
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

    /// <summary>
    /// Owns the pipe listener lifecycle: a cancellation token stops the loop,
    /// requests are size-bounded before allocation (audit IPC-01), and every
    /// parsed call is routed through Core.RequestRouter, never straight into
    /// Mastercam APIs (SAFE-02). One connection is served at a time; within a
    /// connection, requests run concurrently at the transport layer while the
    /// router serializes Mastercam execution (PERF-02).
    /// </summary>
    internal static class BridgeHost
    {
        private static int started;
        private static CancellationTokenSource shutdown;

        public static void Start(string pipeName)
        {
            if (Interlocked.Exchange(ref started, 1) != 0) return;
            shutdown = new CancellationTokenSource();
            RouterHost.Register(new MastercamMcp.Core.RequestRouter(
                new EnvironmentAdapter(), EnvironmentAdapter.DetectMastercamVersion()));
            var thread = new Thread(() => Listen(pipeName, shutdown.Token))
            {
                IsBackground = true,
                Name = "Mastercam MCP named pipe"
            };
            thread.Start();
        }

        /// <summary>Stops the listener; callable from a future NET-Hook unload hook (REL-05).</summary>
        public static void Stop()
        {
            try { shutdown?.Cancel(); } catch { /* already stopped */ }
        }

        private static void Listen(string pipeName, CancellationToken token)
        {
            pipeName = NormalizePipeName(pipeName);
            while (!token.IsCancellationRequested)
            {
                NamedPipeServerStream server = null;
                try
                {
                    server = new NamedPipeServerStream(
                        pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                        PipeOptions.None, 4096, 4096, PipeSecurity());
                    var wait = server.WaitForConnectionAsync(token);
                    wait.Wait(token);
                    ServeConnection(server, RouterHost.Router, token);
                }
                catch (OperationCanceledException)
                {
                    try { server?.Dispose(); } catch { }
                    return; // clean shutdown (REL-05)
                }
                catch (Exception ex)
                {
                    Log(ex);
                    try { server?.Dispose(); } catch { }
                    if (token.WaitHandle.WaitOne(250)) return;
                }
            }
        }

        /// <summary>
        /// Serves one persistent connection: frames are read until the client
        /// closes, accepted requests run to completion and respond in place,
        /// cancels are applied at safe boundaries, and a dropped client cancels
        /// its in-flight work (audit IPC-03).
        /// </summary>
        private static void ServeConnection(NamedPipeServerStream server, MastercamMcp.Core.RequestRouter router, CancellationToken shutdownToken)
        {
            using (var reader = new StreamReader(server, Encoding.UTF8, false, 4096, true))
            using (var writer = new StreamWriter(server, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
            {
                var pending = new List<Task>();
                try
                {
                    while (true)
                    {
                        string line;
                        try { line = ReadBoundedLine(reader); }
                        catch { break; }
                        if (line == null) break; // client closed the connection
                        if (Encoding.UTF8.GetByteCount(line) > MastercamMcp.Protocol.BridgeEnvelope.MaxRequestBytes)
                        {
                            Write(writer, MastercamMcp.Protocol.BridgeEnvelope.ErrorEnvelope(null, null, "REQUEST_TOO_LARGE", "Request exceeds 1 MiB"));
                            continue;
                        }
                        if (router == null)
                        {
                            Write(writer, MastercamMcp.Protocol.BridgeEnvelope.ErrorEnvelope(null, null, "UNSUPPORTED_CAPABILITY",
                                "No live adapter is registered in this build; inspection mappings require licensed verification"));
                            continue;
                        }
                        var outcome = router.Handle(line);
                        if (outcome.IsCancel) continue; // acknowledged silently
                        if (outcome.ImmediateResponse != null)
                        {
                            Write(writer, outcome.ImmediateResponse);
                            continue;
                        }
                        if (outcome.Pending != null)
                        {
                            var execution = outcome.Pending;
                            pending.Add(Task.Run(() =>
                            {
                                try
                                {
                                    var response = execution.GetAwaiter().GetResult();
                                    Write(writer, MastercamMcp.Protocol.BridgeEnvelope.SerializeResponse(response));
                                }
                                catch { /* connection is closing */ }
                            }));
                        }
                    }
                }
                finally
                {
                    router?.CancelAll(); // dropped client: never leave orphaned work running
                    try { Task.WaitAll(pending.ToArray(), 2000); } catch { }
                }
            }
        }

        private static void Write(StreamWriter writer, string line)
        {
            lock (writer) writer.WriteLine(line);
        }

        /// <summary>Reads one line without unbounded buffering: oversized input is cut off at the limit.</summary>
        private static string ReadBoundedLine(StreamReader reader)
        {
            var builder = new StringBuilder();
            var buffer = new char[1024];
            int total = 0;
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int index = 0; index < read; index++)
                {
                    if (buffer[index] == '\n')
                    {
                        return builder.ToString();
                    }
                    builder.Append(buffer[index]);
                    total++;
                    if (total > MastercamMcp.Protocol.BridgeEnvelope.MaxRequestBytes)
                    {
                        return builder.ToString(); // caller rejects with REQUEST_TOO_LARGE
                    }
                }
            }
            return builder.Length > 0 ? builder.ToString() : null;
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

    /// <summary>
    /// Holds the router instance for the running session.
    /// </summary>
    internal static class RouterHost
    {
        private static MastercamMcp.Core.RequestRouter router;

        public static MastercamMcp.Core.RequestRouter Router
        {
            get { return router; }
        }

        public static void Register(MastercamMcp.Core.RequestRouter instance)
        {
            router = instance;
        }
    }
}
