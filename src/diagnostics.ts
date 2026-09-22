import { execFile } from "node:child_process";
import net from "node:net";
import { access, constants, mkdir } from "node:fs/promises";
import { detectInstallations, compatibilityReport } from "./compatibility.js";
import { VERSION } from "./version.js";

export interface DoctorCheck { ok: boolean; value: unknown; required?: string }

function execFileText(command: string, args: string[], timeoutMs = 3000): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : stdout.trim().split(/\r?\n/)[0]);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export async function probePipe(pipe: string, timeoutMs = 750): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection(pipe);
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function findDotnet(): Promise<string | undefined> {
  if (process.platform === "win32") return execFileText("where.exe", ["dotnet"]);
  return execFileText("which", ["dotnet"]);
}

async function auditDirectoryWritable(): Promise<boolean> {
  const path = process.env.MASTERCAM_MCP_AUDIT_PATH ?? `${process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? process.env.TMPDIR ?? "."}/mastercam-mcp`;
  try {
    // The audit log creates the directory on demand; the doctor must not report
    // failure just because nothing has been audited yet on a fresh machine.
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return true;
  } catch {
    return process.env.MASTERCAM_MCP_AUDIT === "0";
  }
}

export async function doctor(pipe: string, backend: string) {
  const [dotnet, pipeReachable, installations, auditWritable] = await Promise.all([
    findDotnet(),
    backend === "mock" ? Promise.resolve(true) : probePipe(pipe),
    Promise.resolve(detectInstallations()),
    auditDirectoryWritable()
  ]);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks: Record<string, DoctorCheck> = {
    node: { ok: nodeMajor >= 22, value: process.version },
    mcpSdk: { ok: true, value: "@modelcontextprotocol/sdk" },
    serverVersion: { ok: true, value: VERSION },
    platform: { ok: backend === "mock" || process.platform === "win32", value: process.platform, required: backend === "mock" ? "informational" : "windows" },
    pipe: { ok: pipeReachable, value: backend === "mock" ? "mock" : pipe },
    dotnet: { ok: backend === "mock" || Boolean(dotnet), value: dotnet ?? "not found" },
    mastercam: { ok: backend === "mock" || installations.length > 0, value: installations.map(item => item.version) },
    audit: { ok: auditWritable, value: auditWritable ? "writable" : "not writable" },
    backend: { ok: true, value: backend },
    security: { ok: true, value: { hardReadOnly: process.env.MASTERCAM_MCP_HARD_READ_ONLY !== "0", profile: process.env.MASTERCAM_MCP_PROFILE ?? "read", httpToken: Boolean(process.env.MASTERCAM_MCP_HTTP_TOKEN) } }
  };
  return {
    ok: Object.values(checks).every(check => check.ok),
    tool: "mastercam_doctor",
    data: {
      checks,
      backend,
      installations,
      compatibility: compatibilityReport(installations),
      guidance: "Run the installer as administrator, restart Mastercam, and invoke the Mastercam MCP NET-Hook entry before testing the live pipe."
    }
  };
}
