# Tool catalog

Mastercam MCP starts with a compact set of 24 tools for the common job workflow. It combines server checks in `get_server_readiness` and gathers selected machining context with `get_job_context`. Each context section reports whether it is available, so missing machine data is not mistaken for a safe value.

The default set includes operation lookup, tool and job recommendations, NC and toolpath review, thread and cycle time calculations, setup notes, and the protected preview, approval, verification, and rollback flow.

Set `MASTERCAM_MCP_TOOLSET=full` before starting the server to expose specialist inspection and analysis tools. A comma-separated `MASTERCAM_MCP_TOOLS` allowlist can select a smaller set from all tools registered for the active backend. When set, the allowlist takes precedence over the preset and remains subject to the backend's live capability and write-protection rules.

The former `get_machine_groups` alias and the generic `inspect`, `measure`, and `assert` tools are no longer registered. Use `list_machine_groups` for machine groups. Use specific operation or job context tools for inspection and verification.

The full catalog does not mean every function is connected to Mastercam. Portable analysis runs on supplied data, and live operation reads remain bounded by the installed adapter. Creating Mastercam operations, generating executable paths, posting, and machine control are not claimed as available.
