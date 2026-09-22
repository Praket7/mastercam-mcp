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
 * Shared network boundary for every HTTP endpoint, including /health.
 * Host/Origin validation precedes authentication so hostile browser/DNS
 * rebinding traffic never reaches MCP or readiness handlers.
 */
export function classifyAccess(
  headers: { origin?: unknown; host?: unknown; authorization?: unknown },
  config: SecurityConfig
): RequestVerdict {
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  const host = typeof headers.host === "string" ? headers.host : undefined;

  if (!config.remote && !isLocalHost(host)) {
    return { status: 403, message: "Host not allowed" };
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
  config: SecurityConfig
): RequestVerdict {
  if (url !== "/mcp") return { status: 404, message: "Not found" };
  return classifyAccess(headers, config);
}
