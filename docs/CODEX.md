# Codex setup

The npm package does not yet include the current source branch. Build the source checkout first. Add the full path to `dist/cli.js` in your Codex MCP settings.

```toml
[mcp_servers.mastercam]
command = 'node'
args = ['C:\path\to\mastercam-mcp\dist\cli.js', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
MASTERCAM_MCP_BACKEND = 'live'
```

Replace the example path with your project folder. Use `mock` when no live Mastercam session is available.

The read profile blocks write tools. Live capability discovery remains authoritative. A passing fixture check does not prove that the native adapter works in Mastercam.

After installation, run `node dist/cli.js doctor`, then `node dist/cli.js acceptance --live` on the licensed Windows workstation.
