using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using Mastercam.App;
using Mastercam.App.Types;

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
        private static int started;
        public static void Start(string pipeName)
        {
            if (System.Threading.Interlocked.Exchange(ref started, 1) != 0) return;
            var thread = new System.Threading.Thread(() => Listen(pipeName)) { IsBackground = true, Name = "Mastercam MCP named pipe" };
            thread.Start();
        }

        private static void Listen(string pipeName)
        {
            pipeName = NormalizePipeName(pipeName);
            while (true)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, PipeSecurity()))
                    {
                        server.WaitForConnection();
                        using (var reader = new StreamReader(server, Encoding.UTF8, false, 4096, true))
                        using (var writer = new StreamWriter(server, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
                        {
                            var request = reader.ReadLine();
                            if (request == null) continue;
                            if (Encoding.UTF8.GetByteCount(request) > MaxRequestBytes)
                                writer.WriteLine("{\"id\":null,\"result\":{\"ok\":false,\"error\":{\"code\":\"REQUEST_TOO_LARGE\",\"message\":\"Request exceeds 1 MiB\"}}}");
                            else writer.WriteLine(Runtime.Dispatch(request));
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log(ex);
                    System.Threading.Thread.Sleep(250);
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
