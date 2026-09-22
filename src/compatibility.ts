import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type RuntimeFamily = "net48" | "net10" | "unknown";

export interface Installation {
  version: string;
  marketingRelease: string;
  runtimeFamily: RuntimeFamily;
  root: string;
  executable: string;
  chooks: string;
  netHookAssemblies: string[];
  verified: boolean;
  confidence: "detected" | "partial";
}

/**
 * Release support is explicit (audit COMPAT-01/70). Mastercam 2027 runs on
 * .NET 10 and cannot load the net48 add-in; the required adapter does not
 * exist yet, so the status says exactly that.
 */
export const COMPATIBILITY_MATRIX = [
  { release: "2024", runtime: ".NET Framework 4.8", adapter: "MastercamMcp.Addin.Legacy", status: "adapter required", evidence: "installer path and assembly discovery" },
  { release: "2025", runtime: ".NET Framework 4.8", adapter: "MastercamMcp.Addin.Legacy", status: "adapter required", evidence: "installer path and assembly discovery" },
  { release: "2026", runtime: ".NET Framework 4.8", adapter: "MastercamMcp.Addin.Legacy", status: "adapter required", evidence: "NET Scripting tooling documents this release" },
  {
    release: "2027",
    runtime: ".NET 10",
    adapter: "MastercamMcp.Addin.2027",
    status: "implementation required",
    evidence: "public developer guidance: Mastercam 2027 moved to .NET 10; older .NET Framework add-ins must be updated"
  }
] as const;

function runtimeFamilyFor(marketingRelease: string): RuntimeFamily {
  const year = Number(marketingRelease);
  return Number.isFinite(year) && year >= 2027 ? "net10" : "net48";
}

function inspectRoot(root: string): Installation | undefined {
  const executable = join(root, "Mastercam.exe");
  const chooks = join(root, "chooks");
  const hasExecutable = existsSync(executable);
  const hasChooks = existsSync(chooks);
  if (!hasExecutable && !hasChooks) return undefined;
  const marketingRelease = root.split(/[\\/]/).pop()?.replace(/^Mastercam\s+/i, "") ?? "unknown";
  const netHookAssemblies = existsSync(root) ? readdirSync(root).filter(file => /^NETHook.*\.dll$/i.test(file)) : [];
  return {
    version: marketingRelease,
    marketingRelease,
    runtimeFamily: runtimeFamilyFor(marketingRelease),
    root,
    executable,
    chooks,
    netHookAssemblies,
    verified: hasExecutable && hasChooks,
    confidence: hasExecutable && hasChooks ? "detected" : "partial"
  };
}

/**
 * INSTALL-01: discovery beyond "C:\Program Files\Mastercam *" — an explicit
 * override wins, then MASTERCAM_ROOT, then Program Files scanning.
 */
export function detectInstallations(programFiles = process.platform === "win32" ? "C:\\Program Files" : ""): Installation[] {
  const roots: string[] = [];
  const explicit = process.env.MASTERCAM_ROOT;
  if (explicit && existsSync(explicit)) roots.push(explicit);
  if (programFiles && existsSync(programFiles)) {
    for (const entry of readdirSync(programFiles, { withFileTypes: true })) {
      if (entry.isDirectory() && /^Mastercam\s+/i.test(entry.name)) {
        const root = join(programFiles, entry.name);
        if (!roots.includes(root)) roots.push(root);
      }
    }
  }
  const installations = roots.map(inspectRoot).filter((item): item is Installation => item !== undefined);
  // Explicit roots first, verified before partial.
  return installations.sort((a, b) => Number(b.verified) - Number(a.verified));
}

export function compatibilityReport(installations: Installation[] = detectInstallations()) {
  return {
    matrix: COMPATIBILITY_MATRIX,
    detected: installations,
    liveMappingsVerified: false,
    note: "Release support requires a matching native adapter and licensed live acceptance testing. Mastercam 2027 requires the .NET 10 adapter, which is not implemented yet."
  };
}
