# mastercam mcp

mastercam mcp connects an MCP client to a live Mastercam session through a local Windows named pipe.

The public project contains the bridge, the add in source, the shared contract, a safe mock backend, an API catalog utility, tests, and installation guidance. It does not contain Mastercam SDK files or customer data. Each user supplies a legitimate local Mastercam installation.

## Current state

The mock path and authenticated Streamable HTTP path are ready for development and automated tests. The live path needs a Windows workstation with Mastercam, its NET Hook assemblies, and the .NET SDK. This repository does not claim live support until those checks pass.

## Design

The client speaks MCP over stdio to the external server. The server sends typed requests over a user protected named pipe. The add in runs inside Mastercam and is the only component allowed to use local Mastercam APIs.

The default profile is read only. Every write accepts dryRun and returns a before and after receipt. Posting creates only a local file after a separate in Mastercam confirmation dialog. There is no arbitrary code execution, machine transfer, DNC, FTP, cycle start, or controller access.

## Quick start

The published package is `mastercam-mcp@0.1.3`. Install Node.js 22 or newer, then use `npx -y mastercam-mcp@latest serve` as the MCP server command in Codex or Claude. No repository checkout is needed.

On Windows, install the Mastercam add in with `npx -y mastercam-mcp@latest install -ConfigureClients`. The installer finds Mastercam automatically, requests one normal Windows administrator approval, copies the add in into `chooks`, and adds safe read only entries to Codex and Claude Desktop when those config files exist.

For source development run npm install, npm run build, npm test, and npm run mock. Set MASTERCAM_MCP_BACKEND to mock before starting the server with npm start.

The package also includes guided diagnostics, tool categories, inspect and measure checks, progress notifications, change previews, rollback receipts, fixture loading, and mock visual verification.

For a real session follow docs/INSTALLATION.md and provide the local Mastercam reference path through the installer. Never copy proprietary assemblies into this repository.

## License

Apache License 2.0
