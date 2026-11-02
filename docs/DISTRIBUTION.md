# Distribution and client setup

## Current package status

Install the latest published release from npm with `npm install --global mastercam-mcp@latest`. A source checkout may include changes that have not shipped yet. Check `mastercam-mcp --version` to confirm which release is installed.

For a local source install, build the project with `pnpm install` and `pnpm run build`. Point your MCP client to `dist/cli.js` inside that checkout. Use the full path to the file.

## Codex

Add an MCP entry that points to the source checkout on your computer.

```toml
[mcp_servers.mastercam]
command = 'node'
args = ['C:\path\to\mastercam-mcp\dist\cli.js', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
MASTERCAM_MCP_BACKEND = 'live'
```

Replace the example path with the actual project folder. Use `mock` as the backend when working without a licensed Windows Mastercam session.

## Claude Desktop

Add this entry inside the existing `mcpServers` object. Replace the example path.

```json
{
  "mastercam": {
    "command": "node",
    "args": ["C:\\path\\to\\mastercam-mcp\\dist\\cli.js", "serve"],
    "env": {
      "MASTERCAM_MCP_PROFILE": "read",
      "MASTERCAM_MCP_BACKEND": "live"
    }
  }
}
```

The read profile blocks write tools. Capability discovery reports what the selected backend can actually do. A fixture result does not prove live Mastercam behavior.

## ChatGPT or another remote client

Use the HTTP entry point only behind an authenticated private connection. Set a strong `MASTERCAM_MCP_HTTP_TOKEN`. Keep the listener on localhost unless a protected tunnel or reverse proxy is required. Remote access also needs allowed origins plus TLS at the trusted boundary. Never expose the Windows named pipe or Mastercam add in directly.

An MCP client must support the current protocol's operator input flow before it can approve a parameter change. If the client cannot present an approval request, changes fail closed.

## Windows add in

Build against the local Mastercam installation. Run `install.ps1` from PowerShell with administrator approval. The installer copies this project's files into the selected `chooks` folder. Mastercam's private SDK files remain on the licensed workstation.

After installation, run `node dist/cli.js doctor`, then run `node dist/cli.js acceptance --live` on that workstation. Mock acceptance checks the portable contract only. It does not establish live readiness.
