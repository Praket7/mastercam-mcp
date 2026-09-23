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
 * Native loader support and live workflow support are separate. Both adapter
 * projects exist, but only environment reporting is implemented until a
 * licensed release-specific acceptance run proves additional mappings.
 */
export const COMPATIBILITY_MATRIX = [
  {
    release: "2024",
    runtime: ".NET Framework 4.8",
    adapter: "MastercamMcp.Addin.Legacy",
    status: "stage-a-environment-only",
    evidence: "Legacy adapter project and installer path are implemented; operation mappings require licensed verification"
  },
  {
    release: "2025",
    runtime: ".NET Framework 4.8",
    adapter: "MastercamMcp.Addin.Legacy",
    status: "stage-a-environment-only",
    evidence: "Legacy adapter project and installer path are implemented; operation mappings require licensed verification"
  },
  {
    release: "2026",
    runtime: ".NET Framework 4.8",
    adapter: "MastercamMcp.Addin.Legacy",
    status: "stage-a-environment-only",
    evidence: "Public NET-Hook examples support the loader family; operation mappings remain unverified"
  },
  {
    release: "2027",
    runtime: ".NET 10",
    adapter: "MastercamMcp.Addin.2027",
    status: "stage-b-read-candidate",
    evidence: "The .NET 10 adapter includes an opt-in runtime-probed operation snapshot and derived read tools; licensed Mastercam 2027 acceptance is required before LIVE_READ_VERIFIED"
  }
] as const;

function runtimeFamilyFor(marketingRelease: string): RuntimeFamily {
  const year = Number(marketingRelease);
  if (!Number.isFinite(year)) return "unknown";
  return year >= 2027 ? "net10" : "net48";
}

function inspectRoot(root: string): Installation | undefined {
  const executable = join(root, "Mastercam.exe");
  const chooks = join(root, "chooks");
  const hasExecutable = existsSync(executable);
  const hasChooks = existsSync(chooks);
  if (!hasExecutable && !hasChooks) return undefined;
  const marketingRelease =
    root.split(/[\\/]/).pop()?.replace(/^Mastercam\s+/i, "") ?? "unknown";
  const netHookAssemblies = existsSync(root)
    ? readdirSync(root).filter(file => /^NETHook.*\.dll$/i.test(file))
    : [];
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

export function detectInstallations(
  programFiles = process.platform === "win32" ? "C:\\Program Files" : ""
): Installation[] {
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
  const installations = roots
    .map(inspectRoot)
    .filter((item): item is Installation => item !== undefined);
  return installations.sort((a, b) => Number(b.verified) - Number(a.verified));
}

export function compatibilityReport(installations: Installation[] = detectInstallations()) {
  return {
    matrix: COMPATIBILITY_MATRIX,
    detected: installations,
    liveMappingsVerified: false,
    stageAAdaptersImplemented: ["MastercamMcp.Addin.Legacy", "MastercamMcp.Addin.2027"],
    stageBReadCandidates: ["MastercamMcp.Addin.2027"],
    note:
      "Legacy releases remain Stage A. Mastercam 2027 has an opt-in Stage-B read candidate built from a runtime-probed programming snapshot. " +
      "No mapping is LIVE_READ_VERIFIED until licensed acceptance evidence proves it."
  };
}
