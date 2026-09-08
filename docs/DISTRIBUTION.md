# Distribution and client setup

The published user path is `mastercam-mcp@0.1.4` through npm. Users do not need a source checkout.

## Codex

```toml
[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', 'mastercam-mcp@latest', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
```

## Claude Desktop

Add this entry inside the existing `mcpServers` object.

```json
{
  "mastercam": {
    "command": "npx.cmd",
    "args": ["-y", "mastercam-mcp@latest", "serve"],
    "env": { "MASTERCAM_MCP_PROFILE": "read" }
  }
}
```

## Windows add in installation

Run this once from PowerShell.

```powershell
npx -y mastercam-mcp@latest install -ConfigureClients
```

Windows shows its standard administrator confirmation because Mastercam is normally under Program Files. Accepting that prompt is the only user interaction. The installer keeps existing client entries and does not overwrite a server named `mastercam`.

The package does not contain Mastercam files. It compiles the add in against the local installation and copies only the project add in into the local `chooks` folder.
