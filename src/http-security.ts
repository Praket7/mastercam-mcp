export interface RequestVerdict {
  status: 200 | 400 | 401 | 403 | 404 | 413;
  message?: string;
}

export interface SecurityConfig {
  token?: string;
  allowedOrigins: Set<string>;
  remote: boolean;
}

export interface RequestSecurityHeaders {
  origin?: unknown;
  host?: unknown;
  authorization?: unknown;
  remoteAddress?: unknown;
}

/** IPv6-aware host parsing: "[::1]:8787" -> "::1" (HTTP-05). */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) return trimmed.slice(1, end);
    return trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > trimmed.lastIndexOf("]")) return trimmed.slice(0, colon);
  return trimmed;
}

function normalizeIpAddress(address: string): string {
  const value = address.trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = normalizeIpAddress(address);
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  if (octets.length !== 4) return false;
  const values = octets.map(value => Number(value));
  return values.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && values[0] === 127;
}

export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader).toLowerCase();
  return name === "localhost" || isLoopbackAddress(name);
}

/**
 * A non-remote server must never bind to a public/interface-wide address.
 * Host headers are client-controlled, so startup binding is the first line
 * of defense and peer-address validation is the second.
 */
export function assertSafeHttpBinding(host: string, remote: boolean): void {
  if (remote) return;
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || isLoopbackAddress(normalized)) return;
  throw new Error(
    `Refusing non-loopback HTTP bind ${host} while remote access is disabled. ` +
      "Set MASTERCAM_MCP_HTTP_ALLOW_REMOTE=1 and configure an Origin allowlist and bearer token for remote access."
  );
}

/**
 * Shared network boundary for every HTTP endpoint, including /health.
 * Host/Origin/peer validation precedes authentication so hostile browser/DNS
 * rebinding traffic never reaches MCP or readiness handlers.
 */
export function classifyAccess(
  headers: RequestSecurityHeaders,
  config: SecurityConfig
): RequestVerdict {
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  const host = typeof headers.host === "string" ? headers.host : undefined;
  const remoteAddress =
    typeof headers.remoteAddress === "string" ? headers.remoteAddress : undefined;

  if (!config.remote) {
    if (!isLocalHost(host)) {
      return { status: 403, message: "Host not allowed" };
    }
    if (remoteAddress !== undefined && !isLoopbackAddress(remoteAddress)) {
      return { status: 403, message: "Peer address not allowed" };
    }
  }

  if (origin && !config.allowedOrigins.has(origin)) {
    return { status: 403, message: "Origin not allowed" };
  }

  if (!config.token) {
    return config.remote ? { status: 401, message: "Unauthorized" } : { status: 200 };
  }

  if (headers.authorization !== `Bearer ${config.token}`) {
    return { status: 401, message: "Unauthorized" };
  }

  return { status: 200 };
}

export function classifyRequest(
  _method: string | undefined,
  url: string | undefined,
  headers: RequestSecurityHeaders,
  config: SecurityConfig
): RequestVerdict {
  if (url !== "/mcp") return { status: 404, message: "Not found" };
  return classifyAccess(headers, config);
}
