# Mastercam MCP

Mastercam MCP connects an MCP client with a local Mastercam session through a protected Windows named pipe. It gives an assistant a careful workflow for inspection, planning, confirmation, verification, and recovery.

The project includes a safe fixture backend so contributors can run the complete workflow without Mastercam or a license. The live adapter reports only capabilities that are actually mapped and verified. It never pretends that an unimplemented Mastercam action succeeded.

## Start without Mastercam

Install Node.js 22 or newer. From this repository run the following commands.

```text
pnpm install
pnpm run build
$env:MASTERCAM_MCP_BACKEND = "mock"
pnpm run mock
pnpm test
node work\feature-smoke.mjs
```

The fixture supports active part inspection, operation search, operation explanation, risk reporting, machine context, feed and speed previews, confirmation gates, reread verification, rollback, regeneration, simulation, collision reporting, visual context, audit history, and diagnostics.

## Connect a client

The published package can be started by any local MCP client.

```text
npx -y mastercam-mcp@latest serve
```

On Windows the installer detects supported Mastercam folders and copies the add in into the selected chooks folder. Administrator approval is required because Program Files is protected.

```text
npx -y mastercam-mcp@latest install -ConfigureClients
```

The installer makes a backup before changing client configuration. It supports installation listing, repair through a repeat install, and uninstall through the PowerShell script.

## Safe workflow

Start with `discover_capabilities` and `mastercam_doctor`. Inspect the active part and operations. Search for the intended operation. Explain it and review its risks. Preview any change. Request explicit confirmation. Apply the change. Regenerate only the affected operations. Reread the result and keep the receipt.

The default server profile is read only. Writes require a write enabled profile and explicit confirmation. Posting, controller communication, DNC, FTP, cycle start, and arbitrary code execution are not provided.

## Main capabilities

Read only inspection includes the active part, geometry, selection, machine groups, operations, tools, stock, WCS, post processor, toolpath state, and cycle estimate.

Planning includes operation targeting, plain language explanations, risk reports, feed and speed previews, change verification, audit history, and fixture replay.

Advanced workflows include regeneration progress, simulation results, collision result models, visual context, and machine context. Fixture results are clearly marked as synthetic and cannot prove live machine safety.

## Live Mastercam setup

Live use requires a legitimate Windows Mastercam installation, its matching NET Hook assemblies, the .NET SDK, and an enabled add in. Run the installer from an Administrator PowerShell window if automatic elevation is not available.

```text
.\install.ps1 -ListInstallations
.\install.ps1 -MastercamRoot "C:\Program Files\Mastercam 2026" -ConfigureClients
```

After starting Mastercam run the diagnostic command.

```text
npx -y mastercam-mcp@latest doctor
```

Live operation mappings depend on the installed Mastercam release and its available API. The compatibility report shows what the add in can prove. A fixture pass is not a substitute for licensed live acceptance testing.

## macOS setup

Install Node.js 22 or newer and pnpm. Open Terminal in the project folder and run the following commands.

```text
pnpm install
pnpm run build
pnpm test
npx -y mastercam-mcp@latest serve
```

macOS starts in portable fixture mode by default. You can set `MASTERCAM_MCP_BACKEND=mock` explicitly when using a client configuration. Live Mastercam NET Hook access is not available on macOS.

## Linux setup

Install Node.js 22 or newer and pnpm. Open a shell in the project folder and run the following commands.

```text
pnpm install
pnpm run build
pnpm test
npx -y mastercam-mcp@latest serve
```

Linux starts in portable fixture mode by default. The setup sheet, JSON comparison, NC comparison, machine validation, fixture replay, stdio transport, and local HTTP transport work without a Windows dependency.

## Windows setup without Mastercam

Install Node.js 22 or newer and pnpm. Open PowerShell in the project folder and run the following commands.

```text
pnpm install
pnpm run build
$env:MASTERCAM_MCP_BACKEND = "mock"
pnpm test
npx -y mastercam-mcp@latest serve
```

Use this mode when developing without a license. It uses the same MCP contract as the live server and clearly marks synthetic results.

## Development checks

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm pack --dry-run
```

Use `MASTERCAM_MCP_FIXTURE` to load a JSON fixture containing a feed value and an operations array. Use `MASTERCAM_MCP_AUDIT_PATH` to select a local audit file.

## Documentation

Installation guidance is in `docs/INSTALLATION.md`. Environment settings are in `docs/ENVIRONMENT.md`. Capability details are in `docs/CAPABILITIES.md`. API evidence and the boundary around proprietary SDK files are in `docs/API-EVIDENCE.md`.

## Shop floor workflows

The server can generate a setup sheet from inspection data, compare tool database snapshots, compare NC text files, and validate an operation against a declared machine profile. These workflows are portable and can run with the fixture backend on Windows, macOS, and Linux.

```text
MASTERCAM_MCP_BACKEND=mock pnpm test
```

On PowerShell use `$env:MASTERCAM_MCP_BACKEND = "mock"` before starting the server. The generated setup sheet is a review document and requires approval. NC comparison is read only. Machine validation reports warnings when controller or holder information is missing.

## Path policy

The live Windows installer checks the selected Mastercam root and its `chooks` folder. Exa verified the standard installation family under `C:\Program Files` and the shared data family under `C:\Users\Public\Documents`. Custom paths are supported through `MastercamRoot`. macOS and Linux use fixture and file workflows because the native Mastercam add in is Windows only.

## License

Apache License 2.0
