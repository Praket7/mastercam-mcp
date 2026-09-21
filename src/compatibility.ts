import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export type Installation = { version: string; root: string; executable: string; chooks: string; netHookAssemblies: string[]; confidence: "detected" | "partial"; productVersion?: string; runtimeFamily?: "net48" | "net10" };

export const COMPATIBILITY_MATRIX = [
  { release: "2024", runtime: ".NET Framework 4.8", status: "adapter required", evidence: "installer path and assembly discovery", adapterName: "MastercamMcp.Addin.Legacy" },
  { release: "2025", runtime: ".NET Framework 4.8", status: "adapter required", evidence: "installer path and assembly discovery", adapterName: "MastercamMcp.Addin.Legacy" },
  { release: "2026", runtime: ".NET Framework 4.8", status: "adapter required", evidence: "NET Scripting tooling documents this release", adapterName: "MastercamMcp.Addin.Legacy" },
  { release: "2027", runtime: ".NET 10", status: "planned verification", evidence: "public developer discussion requires live validation", adapterName: "MastercamMcp.Addin.2027" }
] as const;

export function detectInstallations(programFiles = "C:\\Program Files"): Installation[] {
  if (process.platform !== "win32" || !existsSync(programFiles)) return [];
  const roots: string[] = [];
  if (process.env["MASTERCAM_ROOT"]) roots.push(process.env["MASTERCAM_ROOT"]!);
  if (process.env["MASTERCAM_ROOTS"]) roots.push(...process.env["MASTERCAM_ROOTS"]!.split(";").map(p => p.trim()).filter(Boolean));
  roots.push(programFiles);

  const results: Installation[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^Mastercam\s+/i.test(entry.name)) continue;
        const installRoot = join(root, entry.name);
        const executable = join(installRoot, "Mastercam.exe");
        const chooks = join(installRoot, "chooks");
        const netHookAssemblies = existsSync(installRoot) ? readdirSync(installRoot).filter(file => /^NETHook.*\.dll$/i.test(file)) : [];
        let productVersion: string | undefined;
        let runtimeFamily: "net48" | "net10" | undefined;
        if (existsSync(executable)) {
          try {
            const versionInfo = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Item '${executable}').VersionInfo.ProductVersion`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
            if (versionInfo) {
              productVersion = versionInfo;
if (versionInfo) {
              const major = versionInfo.split(".")[0] ?? "";
              if (major === "27") runtimeFamily = "net10";
              else if (["24", "25", "26"].includes(major)) runtimeFamily = "net48";
            }
            }
          } catch { }
        }
        const confidence: Installation["confidence"] = existsSync(executable) && existsSync(chooks) ? "detected" : "partial";
        results.push({ version: entry.name.replace(/^Mastercam\s+/i, ""), root: installRoot, executable, chooks, netHookAssemblies, confidence, productVersion: productVersion ?? "", runtimeFamily: runtimeFamily ?? "net48" });
      }
    } catch { }
  }
  return results.filter(item => existsSync(item.executable) || existsSync(item.chooks));
}

export function compatibilityReport(installations: Installation[] = detectInstallations()) {
  return { matrix: COMPATIBILITY_MATRIX, detected: installations, liveMappingsVerified: false, note: "Release support requires a matching native adapter and licensed live acceptance testing" };
}