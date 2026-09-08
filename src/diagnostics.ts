import { execFileSync } from "node:child_process";
import net from "node:net";

export async function doctor(pipe: string, backend: string) {
  const dotnet = findDotnet();
  const pipeReachable = backend === "mock" ? true : await probePipe(pipe);
  const checks = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.version },
    platform: { ok: backend === "mock" || process.platform === "win32", value: process.platform, required: backend === "mock" ? "informational" : "windows" },
    pipe: { ok: pipeReachable, value: backend === "mock" ? "mock" : pipe },
    dotnet: { ok: backend === "mock" || Boolean(dotnet), value: dotnet ?? "not found" }
  };
  return { ok: Object.values(checks).every(check => check.ok), tool: "mastercam_doctor", data: { checks, backend, guidance: "Run the installer as administrator, restart Mastercam, and invoke the Mastercam MCP NET-Hook entry before testing the live pipe." } };
}

function probePipe(pipe: string) {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection(pipe);
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function findDotnet() {
  try {
    return execFileSync(process.platform === "win32" ? "where.exe" : "which", ["dotnet"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}
