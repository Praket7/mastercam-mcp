# Security

Mastercam MCP is designed for one Windows user on one workstation.

The add in accepts commands only through a Windows named pipe protected for the current user. It does not expose a LAN service. The external server defaults to stdio. Remote Streamable HTTP is opt in. Local mode rejects non-loopback Host headers, browser Origins must be explicitly allow-listed, and remote mode requires a bearer token plus an allow-list. For remote use, terminate TLS at a trusted reverse proxy or authenticated private tunnel and expose only the MCP endpoint.

Do not report proprietary Mastercam files, customer files, credentials, license data, generated API indexes, or browser data in an issue. Please use [GitHub private vulnerability reporting](https://github.com/Praket7/mastercam-mcp/security/advisories/new) for suspected vulnerabilities instead of opening a public issue.

The current MCP HTTP implementation is stateless for the `2026-07-28` protocol and does not rely on `Mcp-Session-Id`. Mutation safety state is carried only by bounded server-minted approval, transaction, and idempotency handles.

Audit-log integrity failures are fail-closed at startup for audited operation. Audit entries are hash chained across restarts and rotations; secrets, authorization values, approval tokens, rollback tokens, access tokens, refresh tokens, and idempotency keys are redacted before persistence.
