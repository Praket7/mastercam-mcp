import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type Installation = { version: string; root: string; executable: string; chooks: string; netHookAssemblies: string[]; confidence: "detected" | "partial" };

export const COMPATIBILITY_MATRIX = [
  { release: "2024", runtime: ".NET Framework 4.8", status: "adapter required", evidence: "installer path and assembly discovery" },
  { release: "2025", runtime: ".NET Framework 4.8", status: "adapter required", evidence: "installer path and assembly discovery" },
  { release: "2026", runtime: ".NET Framework 4.8", status: "adapter required", evidence: "NET Scripting tooling documents this release" },
  { release: "2027", runtime: ".NET 10", status: "planned verification", evidence: "public developer discussion requires live validation" }
] as const;

export function detectInstallations(programFiles = "C:\\Program Files"): Installation[] {
  if (process.platform !== "win32" || !existsSync(programFiles)) return [];
  return readdirSync(programFiles, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^Mastercam\s+/i.test(entry.name))
    .map(entry => {
      const root = join(programFiles, entry.name);
      const executable = join(root, "Mastercam.exe");
      const chooks = join(root, "chooks");
      const netHookAssemblies = existsSync(root) ? readdirSync(root).filter(file => /^NETHook.*\.dll$/i.test(file)) : [];
      const confidence: Installation["confidence"] = existsSync(executable) && existsSync(chooks) ? "detected" : "partial";
      return { version: entry.name.replace(/^Mastercam\s+/i, ""), root, executable, chooks, netHookAssemblies, confidence };
    })
    .filter(item => existsSync(item.executable) || existsSync(item.chooks));
}

export function compatibilityReport(installations: Installation[] = detectInstallations()) {
  return { matrix: COMPATIBILITY_MATRIX, detected: installations, liveMappingsVerified: false, note: "Release support requires a matching native adapter and licensed live acceptance testing" };
}
