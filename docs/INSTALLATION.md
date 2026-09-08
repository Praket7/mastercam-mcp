# Installation

Install Node.js 22 or newer and the .NET SDK supported by the installed Mastercam release.

For end users, run `npx -y mastercam-mcp@latest install -ConfigureClients`. This detects Mastercam, builds against its local NET Hook assembly, requests Windows administrator approval, copies both the add in DLL and its function table into `chooks`, and adds safe read only entries to Codex and Claude Desktop.

Build the external server with `npm install` followed by `npm run build`.

Build the add in from `native/MastercamMcp.Addin` after setting `MASTERCAM_ROOT` to the user supplied Mastercam installation. The project deliberately references the local NET Hook assembly and never copies it into the repository.

Install the resulting add in in the Mastercam chooks directory for the matching release. Start Mastercam first, load the add in, then start the MCP server with stdio. The default profile is read only. Enable writes only in a dedicated test part with `MASTERCAM_MCP_PROFILE=core` and keep `MASTERCAM_MCP_HARD_READ_ONLY=1` until the safety checks are complete.
The installer supports `-ListInstallations` to show all detected Mastercam versions and `-Uninstall -MastercamRoot "..."` to remove only the MCP add in files from a selected installation.
