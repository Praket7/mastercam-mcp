# Capability status

This table is deliberately conservative.

| Area | Status | Evidence |
| --- | --- | --- |
| MCP initialization | Supported | Automated stdio smoke test |
| Tool discovery | Supported | 36 tools discovered in feature smoke test |
| Read only profile | Supported | Unit tests and smoke test |
| Dry run receipt | Supported | Mock feed change test |
| Diagnostics and guided plan | Supported | Feature smoke test |
| Inspect, measure, and assert | Mock tested | Fixture backend tests |
| Progress notifications | Mock tested | Feature smoke test received progress events |
| Change preview and rollback | Mock tested | Fixture backend tests |
| Visual verification payload | Mock tested | SVG capture fixture |
| Commit and reread receipt | Mock tested | Mock feed change apply reread restore |
| Named pipe transport | Source implemented | Windows add in source present |
| Mastercam API catalog | Source implemented | Local reflection utility present |
| NET Hook loading | Unverified | Mastercam SDK absent on preflight machine |
| Live Mastercam reads | Unverified | Mastercam absent on preflight machine |
| Live Mastercam writes | Unverified | Mastercam absent on preflight machine |
| Codex live client | Unverified | No live backend available |
| ChatGPT web client | Transport implemented and mock verified | Live ChatGPT web connection remains unverified |
| Posting | Disabled | High risk tool is denied by policy |
| Machine execution | Not implemented | Deliberately outside project scope |
