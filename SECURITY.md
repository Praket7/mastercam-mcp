# Security

Mastercam MCP is designed for one Windows user on one workstation.

The add in accepts commands only through a Windows named pipe protected for the current user. It does not expose a LAN service. The external server defaults to stdio. Remote Streamable HTTP is opt in and must be placed behind an authenticated private tunnel.

Do not report proprietary Mastercam files, customer files, credentials, license data, generated API indexes, or browser data in an issue. Please use the private security contact configured in the repository when one is available.
