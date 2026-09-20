import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export type BackendMode = "mock" | "pipe";

export function selectedBackend(): BackendMode {
  const requested = process.env.MASTERCAM_MCP_BACKEND;
  if (requested === "mock" || requested === "pipe") return requested;
  return process.platform === "win32" ? "pipe" : "mock";
}

/**
 * Windows uses a named pipe; Unix uses a user-scoped abstract-free socket path
 * under the user's temp/cache area so two users never collide (audit BUG-10).
 */
export function defaultPipe(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\mastercam-mcp-default";
  let user = "unknown";
  try { user = userInfo().username.replace(/[^A-Za-z0-9_-]/g, ""); } catch { user = String(process.getuid?.() ?? "unknown"); }
  const base = process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `mastercam-mcp-${user}`);
  return join(base, "mastercam-mcp-default.sock");
}

export function platformGuidance() {
  return process.platform === "win32"
    ? "Windows can use a live Mastercam NET Hook or the portable fixture backend"
    : "This platform uses the portable fixture and file workflows because live Mastercam NET Hook access is Windows only";
}

export function homeDir(): string {
  return homedir();
}
