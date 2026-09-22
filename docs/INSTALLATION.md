# Installation

Install Node.js 22 or newer and the .NET SDK supported by the installed Mastercam release.

For end users, run `npx -y mastercam-mcp@latest install -ConfigureClients`. This detects Mastercam, builds against its local NET Hook assembly, requests Windows administrator approval, copies both the add in DLL and its function table into `chooks`, and adds read-profile entries to Codex and Claude Desktop.

Build the external server with `pnpm install` followed by `pnpm run build` when working from source.

Build the release-specific add in from `native/MastercamMcp.Addin.Legacy` or `native/MastercamMcp.Addin.2027` after setting `MASTERCAM_ROOT` to the user-supplied Mastercam installation. The project deliberately references the local proprietary NET Hook assembly and never copies it into the repository or npm package.

Install the resulting add in in the Mastercam `chooks` directory for the matching release. Start Mastercam first, load the add in, then start the MCP server with stdio. Keep `MASTERCAM_MCP_PROFILE=read` during initial validation. The current Stage-A adapters expose only `mastercam_status` and `mastercam_capabilities`; installation alone does not make operation inspection or mutation live-ready.

After installation run:

```text
npx -y mastercam-mcp@latest doctor
npx -y mastercam-mcp@latest acceptance --live
```

Do **not** enable the write profile merely because installation or fixture tests passed. Write enablement belongs only on a disposable test part after release-specific live mappings exist and the acceptance report shows the required live reads are ready. Then evaluate writes explicitly with `acceptance --live --allow-writes`. A live write profile should remain disabled unless that controlled acceptance path reports write readiness.

The installer supports `-ListInstallations` to show detected Mastercam versions and `-Uninstall -MastercamRoot "..."` to remove only the MCP add in files from a selected installation.

## macOS and Linux

The portable server works on macOS and Linux with Node.js 22 or newer. These systems start in fixture mode when no backend is selected. This allows setup sheet generation, tool database comparison, NC comparison, machine validation, MCP stdio, local HTTP, and automated contract tests without Mastercam.

```text
pnpm install
pnpm run build
pnpm test
npx -y mastercam-mcp@latest doctor
npx -y mastercam-mcp@latest serve
```

Set `MASTERCAM_MCP_BACKEND=mock` when a client configuration needs an explicit value. Use `MASTERCAM_MCP_FIXTURE` to load a portable JSON fixture. Live NET Hook communication is available only on Windows because the add in runs inside Mastercam.

## Cross platform path behavior

The portable layer uses the current working folder and environment values rather than a fixed home folder. Windows live installation uses the selected Mastercam root and its `chooks` folder. Mastercam administrator guidance places shared data under the public documents folder. macOS and Linux do not attempt to create Windows folders.

## Protocol compatibility

The server explicitly supports MCP revision `2026-07-28` through the SDK v2 serving entry points. Legacy 2025-era clients remain supported as a compatibility path, but HTTP legacy serving is stateless and should not be used as evidence that a client negotiated the modern revision. The repository smoke tests pin `2026-07-28` to verify the current protocol path.

Mastercam release-specific add-ins still require the matching locally installed proprietary NET Hook assemblies. Public CI validates the portable shared projects and protocol/native contract layers; a release-specific add-in is not considered live verified until it builds, loads, and passes acceptance testing in a licensed Mastercam installation.
