export type BackendMode = "mock" | "pipe";

export function selectedBackend(): BackendMode {
  const requested = process.env.MASTERCAM_MCP_BACKEND;
  if (requested === "mock" || requested === "pipe") return requested;
  return process.platform === "win32" ? "pipe" : "mock";
}

export function defaultPipe() {
  return process.platform === "win32" ? "\\\\.\\pipe\\mastercam-mcp-default" : "mastercam-mcp-default.sock";
}

export function platformGuidance() {
  return process.platform === "win32"
    ? "Windows can use a live Mastercam NET Hook or the portable fixture backend"
    : "This platform uses the portable fixture and file workflows because live Mastercam NET Hook access is Windows only";
}
