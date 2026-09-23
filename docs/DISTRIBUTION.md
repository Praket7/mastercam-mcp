# Distribution and client setup

The supported end-user path is the npm package through `mastercam-mcp@latest`; the current repository package version is `0.3.0`. Users do not need a source checkout.

## Codex

```toml
[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', 'mastercam-mcp@latest', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
MASTERCAM_MCP_BACKEND = 'live'
```

## Claude Desktop

Add this entry inside the existing `mcpServers` object.

```json
{
  "mastercam": {
    "command": "npx.cmd",
    "args": ["-y", "mastercam-mcp@latest", "serve"],
    "env": {
      "MASTERCAM_MCP_PROFILE": "read",
      "MASTERCAM_MCP_BACKEND": "live"
    }
  }
}
```

The read profile prevents mutation tools from running. Live capability discovery remains authoritative: the current Stage-A native adapters expose only environment/status capabilities until release-specific Mastercam mappings pass licensed acceptance.

## Windows add in installation

Run this once from PowerShell.

```powershell
npx -y mastercam-mcp@latest install -ConfigureClients
```

Windows shows its standard administrator confirmation because Mastercam is normally under Program Files. Accepting that prompt is the only elevation step. The installer keeps existing client entries and does not overwrite a server named `mastercam`.

The package does not contain proprietary Mastercam assemblies. It compiles the add in against the user's local installation and copies only this project's add in DLL and function table into the selected local `chooks` folder.

After installation, run `npx -y mastercam-mcp@latest doctor` and then `npx -y mastercam-mcp@latest acceptance --live`. A fixture/mock acceptance pass is useful for contract testing but is not evidence of live Mastercam readiness.
