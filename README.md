# Mastercam MCP

Mastercam MCP connects an MCP client with a local Mastercam session through a protected Windows named pipe. It gives an assistant a careful workflow for inspection, planning, confirmation, verification, and recovery.

The project includes a safe fixture backend so contributors can run the portable workflow without Mastercam or a license. The live adapter reports only capabilities that are actually mapped and verified. It never pretends that an unimplemented Mastercam action succeeded.

## Start without Mastercam

Install Node.js 22 or newer. From this repository run the following commands.

```text
pnpm install
pnpm run build
$env:MASTERCAM_MCP_BACKEND = "mock"
pnpm test
pnpm run smoke
```

The fixture supports active part inspection, operation search, operation explanation, risk reporting, machine context, feed and speed previews, confirmation gates, reread verification, rollback, simulation, collision reporting, visual context, audit history, and diagnostics.

## MCP protocol

The server uses the stable Model Context Protocol TypeScript SDK v2 packages and explicitly serves the current `2026-07-28` protocol revision. Stdio uses the SDK's `serveStdio` entry point and Streamable HTTP uses `createMcpHandler` with the Node adapter, so modern clients negotiate the 2026 per-request protocol rather than silently falling back to the older initialize handshake.

For interoperability, the same endpoints retain a deliberate 2025-era fallback. Stdio can accept a legacy opening and HTTP serves legacy requests statelessly. The 2026 HTTP path does not create or depend on `Mcp-Session-Id`. Automated smoke tests pin `2026-07-28` so a regression to legacy-only serving fails CI.

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

Start with `discover_capabilities` and `mastercam_doctor`. Inspect the active part and operations. Search for the intended operation. Explain it and review its risks. Preview any change. Request explicit confirmation. Apply the change. Reread and verify the result, and keep the server-issued transaction and rollback receipt.

Standalone `regenerate_toolpath` is intentionally not registered yet. Regeneration changes CAM state and must be bound to the exact approved mutation transaction before it is safe to automate. Until that transaction-bound workflow is implemented and verified, regenerate manually in Mastercam when required rather than bypassing the approval boundary.

The default server profile is read only. Writes require `MASTERCAM_MCP_PROFILE=write` (or `all` for development), `MASTERCAM_MCP_HARD_READ_ONLY=0`, and the preview/approval workflow. Posting, controller communication, DNC, FTP, cycle start, and arbitrary code execution are not provided.

## Capability boundary

The portable fixture backend implements the public inspection and safety contract: active part, geometry, selection, machine groups, operations, tools, stock, WCS, post processor, toolpath state, cycle estimates, previews, verification, rollback, simulation, collision models, visual context, and machine context.

The native Legacy and 2027 adapters currently implement **Stage A environment reporting only**: `mastercam_status` and `mastercam_capabilities`. They do not advertise operation, tool, stock, WCS, simulation, or mutation tools until those mappings are implemented against the matching Mastercam SDK and pass licensed live acceptance.

This distinction is deliberate. A fixture pass proves the MCP contract and safety pipeline, not live Mastercam behavior. Run `mastercam-mcp acceptance --live` on Windows to see the exact live-readiness blockers for the installed release.

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

Both native adapter families are present, including the .NET 10 adapter for Mastercam 2027, but only environment reporting is implemented today. The compatibility report and `acceptance --live` command show what the add in can actually prove. A live acceptance run exits nonzero until the required inspection mappings pass, and `--allow-writes` additionally gates preview, apply, verify, and rollback readiness.

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

Use `MASTERCAM_MCP_FIXTURE` to load a JSON fixture containing a feed value and an operations array. Use `MASTERCAM_MCP_AUDIT_PATH` to select a local audit file. Runtime audit JSONL files are ignored by source control and package rules.

## Documentation

Installation guidance is in `docs/INSTALLATION.md`. Environment settings are in `docs/ENVIRONMENT.md`. Capability details are in `docs/CAPABILITIES.md`. Job-intelligence design research is in `docs/JOB-INTELLIGENCE.md`. API evidence and the boundary around proprietary SDK files are in `docs/API-EVIDENCE.md`.

## Shop floor workflows

The server now includes a portable job-intelligence layer in addition to setup-sheet, NC comparison, tool-database comparison, and machine-profile validation.

- `recommend_job_tooling` ranks only tools from the supplied shop/tool library and hard-rejects known material, geometry, depth, or machine incompatibilities before scoring preferences.
- `analyze_toolpath_risk` checks supplied motion segments against declared travel, feed/RPM limits, safe Z, stock and fixture bounding volumes, conservative swept envelopes, and optional approach-angle thresholds.
- `analyze_cycle_time` separates cutting time from rapids, air-feed, dwell, and tool-change time, then returns reviewable non-cutting opportunities without claiming that all of that time can safely be removed.
- `generate_operation_packet` builds setup and operation notes directly from a supplied operation tree and tool records while flagging dirty operations and unresolved tooling.
- `calculate_thread_tap` resolves metric and Unified callouts, calculates basic thread geometry, cut-tap drill guidance, synchronized feed, and RPM from supplied geometry and cutting data.
- `plan_od_rough_finish` converts a structured OD profile plus shop tooling/material/machine limits into a rough-and-finish process-plan preview. It is deliberately non-executable and cannot create Mastercam operations, post NC, transfer programs, or start a machine.

These tools are server-local. They can consume fixture data or structured evidence supplied by an MCP client in live mode, but that does **not** mean the current native adapter can read the active Mastercam tool library or toolpath tree. Live native mappings remain Stage A until implemented and accepted on a licensed workstation.

```text
MASTERCAM_MCP_BACKEND=mock pnpm test
```

On PowerShell use `$env:MASTERCAM_MCP_BACKEND = "mock"` before starting the server. Generated recommendations and setup packets are review evidence, not machine authorization. NC comparison is read only, and machine/toolpath checks report unknowns when the supplied evidence is incomplete.

## Path policy

The live Windows installer checks the selected Mastercam root and its `chooks` folder. Public Mastercam guidance places standard installations under `C:\Program Files` and shared data under the public documents family. Custom paths are supported through `MastercamRoot`. macOS and Linux use fixture and file workflows because the native Mastercam add in is Windows only.

## License

Apache License 2.0
