import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export type BackendMode = "mock" | "live";

export function selectedBackend(requested = process.env.MASTERCAM_MCP_BACKEND ?? "auto"): BackendMode {
  if (requested === "mock") return "mock";
  if (requested === "live" || requested === "pipe") return "live";
  if (requested !== "auto" && requested !== "") {
    throw new Error(`Invalid MASTERCAM_MCP_BACKEND: ${requested}. Use auto, mock, live, or pipe.`);
  }
  return process.platform === "win32" ? "live" : "mock";
}

export function defaultPipe(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\mastercam-mcp-default";
  let user = "unknown";
  try {
    user = userInfo().username.replace(/[^A-Za-z0-9_-]/g, "");
  } catch {
    user = String(process.getuid?.() ?? "unknown");
  }
  const base = process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `mastercam-mcp-${user}`);
  return join(base, "mastercam-mcp-default.sock");
}

export function platformGuidance(): string {
  return process.platform === "win32"
    ? "Windows can use a live Mastercam NET Hook or the portable fixture backend"
    : "Live Mastercam NET Hook access is Windows-only; use the mock backend on this platform";
}

export function homeDir(): string {
  return homedir();
}
