// @ts-nocheck
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

export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader).toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/**
 * Origin validation happens before authentication. Browser requests always
 * carry an Origin header; a non-browser MCP client normally sends none. Any
 * Origin that is not explicitly allow-listed is rejected with 403 (DNS
 * rebinding protection, audit HTTP-01/SEC-05); localhost requests without an
 * Origin stay reachable without a token for local development.
 */
export function classifyRequest(
  method: string | undefined,
  url: string | undefined,
  headers: { origin?: unknown; host?: unknown; authorization?: unknown },
  config: SecurityConfig
): RequestVerdict {
  if (url !== "/mcp") return { status: 404, message: "Not found" };
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  if (origin) {
    const hostAllowed = !config.remote || isLocalHost(typeof headers.host === "string" ? headers.host : undefined);
    if (!config.allowedOrigins.has(origin) || !hostAllowed) {
      return { status: 403, message: "Origin not allowed" };
    }
  }
  if (!config.token) {
    return config.remote ? { status: 401, message: "Unauthorized" } : { status: 200 };
  }
  if (headers.authorization !== `Bearer ${config.token}`) return { status: 401, message: "Unauthorized" };
  if (!config.remote && !isLocalHost(typeof headers.host === "string" ? headers.host : undefined)) {
    return { status: 403, message: "Host not allowed" };
  }
  return { status: 200 };
}
