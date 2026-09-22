export interface RequestVerdict {
  status: 200 | 400 | 401 | 403 | 404 | 413;
  message?: string;
}

export interface SecurityConfig {
  token?: string;
  allowedOrigins: Set<string>;
  remote: boolean;
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

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice("::ffff:".length));
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(normalized);
  if (!match) return false;
  const first = Number(match[1]);
  return first === 127;
}

export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return isLoopbackAddress(hostnameOf(hostHeader));
}

/**
 * Shared network boundary for every HTTP endpoint, including /health.
 * Host/Origin validation precedes authentication so hostile browser/DNS
 * rebinding traffic never reaches MCP or readiness handlers.
 *
 * In local-only mode the socket peer must also be loopback. This prevents a
 * remote client connected to a mistakenly public bind from bypassing the
 * boundary simply by forging `Host: 127.0.0.1`.
 */
export function classifyAccess(
  headers: { origin?: unknown; host?: unknown; authorization?: unknown },
  config: SecurityConfig,
  remoteAddress?: string
): RequestVerdict {
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  const host = typeof headers.host === "string" ? headers.host : undefined;

  if (!config.remote) {
    if (!isLocalHost(host)) return { status: 403, message: "Host not allowed" };
    if (remoteAddress !== undefined && !isLoopbackAddress(remoteAddress)) {
      return { status: 403, message: "Remote peer not allowed" };
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
  headers: { origin?: unknown; host?: unknown; authorization?: unknown },
  config: SecurityConfig,
  remoteAddress?: string
): RequestVerdict {
  if (url !== "/mcp") return { status: 404, message: "Not found" };
  return classifyAccess(headers, config, remoteAddress);
}
