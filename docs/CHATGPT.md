# ChatGPT configuration

Use the Streamable HTTP entry point only behind an authenticated private endpoint. Start the HTTP server with `pnpm run start:http` (or the packaged equivalent) and set `MASTERCAM_MCP_HTTP_TOKEN` to a strong random secret. The listener binds to localhost by default. Host and Origin validation run before the MCP handler. If a private tunnel or reverse proxy is used, enable remote HTTP deliberately, configure `MASTERCAM_MCP_ALLOWED_ORIGINS`, terminate TLS at the trusted boundary, and expose only the MCP HTTP listener. Never expose the Windows named pipe or Mastercam add in directly.

Install the latest published release with `npm install --global mastercam-mcp@latest`. If you are using a source checkout, build it first and point the client at that checkout. A remote client must connect through the authenticated HTTP entry point.

The Legacy adapter reports its environment. Mastercam 2027 has an optional read candidate for a limited operation snapshot. Neither has passed full live acceptance. Run `node dist/cli.js acceptance --live` on a licensed Windows workstation to review the exact checks. Fixture results show the portable contract only.
