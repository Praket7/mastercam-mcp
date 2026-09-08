# mastercam mcp

mastercam mcp connects an MCP client to a live Mastercam session through a local Windows named pipe.

The public project contains the bridge, the add in source, the shared contract, a safe mock backend, an API catalog utility, tests, and installation guidance. It does not contain Mastercam SDK files or customer data. Each user supplies a legitimate local Mastercam installation.

## Current state

The mock path is ready for development and automated tests. The live path needs a Windows workstation with Mastercam, its NET Hook assemblies, and the .NET SDK. This repository does not claim live support until those checks pass.

## Design

The client speaks MCP over stdio to the external server. The server sends typed requests over a user protected named pipe. The add in runs inside Mastercam and is the only component allowed to use local Mastercam APIs.

The default profile is read only. Every write accepts dryRun and returns a before and after receipt. Posting creates only a local file after a separate in Mastercam confirmation dialog. There is no arbitrary code execution, machine transfer, DNC, FTP, cycle start, or controller access.

## Quick start

Install Node.js 22 or newer. Run npm install and npm run build. Run npm test for the mock contract tests. Start the mock backend with npm run mock, then set MASTERCAM_MCP_BACKEND to mock before starting the server with npm start.

For a real session follow docs/INSTALLATION.md and provide the local Mastercam reference path through the installer. Never copy proprietary assemblies into this repository.

## License

Apache License 2.0
