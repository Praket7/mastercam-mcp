# Codex configuration

Register the published server as a local stdio MCP server. Codex can download the current package automatically through npm.

```toml
[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', 'mastercam-mcp@latest', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
MASTERCAM_MCP_BACKEND = 'live'
```

The read profile prevents public write tools from executing. Capability discovery remains authoritative: the current native adapters expose only Stage A environment/status capabilities until release-specific mappings pass licensed live acceptance.

After installing the add in, start Mastercam and run `npx -y mastercam-mcp@latest doctor`, followed by `npx -y mastercam-mcp@latest acceptance --live`. A mock/fixture pass validates the MCP contract but is not evidence that Mastercam operations work live.
