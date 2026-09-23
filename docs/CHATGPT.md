# ChatGPT configuration

Use the Streamable HTTP entry point only behind an authenticated private endpoint. Start the HTTP server with `pnpm run start:http` (or the packaged equivalent) and set `MASTERCAM_MCP_HTTP_TOKEN` to a strong random secret. The listener binds to localhost by default. Host and Origin validation run before the MCP handler. If a private tunnel or reverse proxy is used, enable remote HTTP deliberately, configure `MASTERCAM_MCP_ALLOWED_ORIGINS`, terminate TLS at the trusted boundary, and expose only the MCP HTTP listener. Never expose the Windows named pipe or Mastercam add in directly.

The supported package path is `mastercam-mcp@latest`; the current repository package version is `0.3.0`. Local desktop clients can use the stdio entry point. A remote/client-hosted integration should use the authenticated HTTP entry point.

The current native Legacy and 2027 adapters are Stage A environment bridges. They can prove connection/status and capability discovery, but broader live inspection and mutation mappings are not advertised until they are implemented against the matching Mastercam SDK and pass licensed acceptance. Run `mastercam-mcp acceptance --live` on a licensed Windows workstation to see the exact blockers. Fixture/mock results are contract evidence only and do not establish live Mastercam readiness.
