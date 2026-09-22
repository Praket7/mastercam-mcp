# Codex configuration

Register the published server as a local stdio MCP server. Codex can download the current package automatically through npm.

```toml
[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', 'mastercam-mcp@latest', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
```

This checkout could not perform a Codex live call because Mastercam and its SDK were not installed during preflight. The mock contract path is covered by automated tests.
