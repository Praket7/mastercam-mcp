using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using Mastercam.App;
using Mastercam.App.Types;

namespace MastercamMcp.Addin
{
    public sealed class EntryPoint : NetHook3App
    {
        public override MCamReturn Run(int param)
        {
            using (var server = new NamedPipeServerStream(PipeName(), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            {
                server.WaitForConnection();
                using (var reader = new StreamReader(server, Encoding.UTF8, false, 4096, true))
                using (var writer = new StreamWriter(server, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
                {
                    var request = reader.ReadLine();
                    if (request != null) writer.WriteLine(Runtime.Dispatch(request));
                }
            }
            return MCamReturn.NoErrors;
        }

        private static string PipeName() => Environment.GetEnvironmentVariable("MASTERCAM_MCP_PIPE") ?? "mastercam-mcp-default";
    }
}
