# Environment

The 2026 09 08 preflight was performed on Windows.

Node.js 24 was available through the bundled workspace runtime. Git was available. A system .NET SDK, Visual Studio, Mastercam executable, NETHook3_0.dll, ToolNetApi.dll, and SimAccessManaged.dll were not found in the standard program locations searched.

No user name, license identifier, account identifier, or private machine path is stored here.

## Boolean settings

Boolean environment settings accept `true`, `false`, `1`, and `0` without regard to letter case. The HTTP remote access setting defaults to false. A misspelled value stops startup instead of silently changing the security setting. Keep remote access off unless you have configured the required bearer token and origin allowlist.

Audit logging is enabled by default. Set `MASTERCAM_MCP_AUDIT` to `false` or `0` to turn it off. The configuration check and the audit logger use the same setting rules.

## Shop tool catalog

Set `MASTERCAM_MCP_TOOL_LIBRARY` to an operator-maintained JSON tool catalog to ground recommendations and setup packets in shop inventory. The `mastercam-mcp/tool-library/v1` schema, supported fields, size limits, and live-reference merge behavior are documented in [Job Intelligence](JOB-INTELLIGENCE.md#tooling-recommendations). JSON export is supported; proprietary Mastercam `.TOOLDB` parsing is not.


## Stage-B Mastercam 2027 read candidate

`MASTERCAM_MCP_ENABLE_STAGE_B_READS` is disabled by default. Set it to `1` or `true` only when evaluating the Mastercam 2027 read-only candidate on a licensed workstation.

The variable must be inherited by the Mastercam process because the native add-in reads it in-process. Enabling it exposes only the Stage-B read candidates; it does not enable mutations or override `MASTERCAM_MCP_PROFILE` / `MASTERCAM_MCP_HARD_READ_ONLY`.

The current candidate reads the active operation enumeration and derives exact operation reads and referenced tools from a bounded snapshot. It does not establish complete tool-library, stock, WCS, active-part, toolpath-motion, simulation, or write support.
