import type { Profile } from "../contracts.js";
import { READ_TOOLS, WRITE_TOOLS, ADVANCED_TOOLS } from "../contracts.js";

export interface SafetyPolicy {
  profile: Profile;
  hardReadOnly: boolean;
  allowedTools: Set<string>;
  requireApprovalFor: Set<string>;
  dryRunAllowed: Set<string>;
}

export function createSafetyPolicy(profile: Profile, hardReadOnly: boolean): SafetyPolicy {
  const allowedTools = new Set<string>();
  const requireApprovalFor = new Set<string>();
  const dryRunAllowed = new Set<string>();

  for (const tool of READ_TOOLS) allowedTools.add(tool);
  if (!hardReadOnly) {
    if (profile === "core" || profile === "write" || profile === "advanced" || profile === "dev") {
      for (const tool of WRITE_TOOLS) { allowedTools.add(tool); requireApprovalFor.add(tool); }
    }
    if (profile === "advanced" || profile === "dev") {
      for (const tool of ADVANCED_TOOLS) { allowedTools.add(tool); requireApprovalFor.add(tool); }
    }
  }

  for (const tool of [...READ_TOOLS, ...WRITE_TOOLS, ...ADVANCED_TOOLS]) {
    dryRunAllowed.add(tool);
  }

  return { profile, hardReadOnly, allowedTools, requireApprovalFor, dryRunAllowed };
}

export function checkToolAllowed(policy: SafetyPolicy, tool: string, dryRun: boolean): { allowed: boolean; reason?: string; requiresApproval?: boolean } {
  if (dryRun && policy.dryRunAllowed.has(tool)) return { allowed: true };
  if (!policy.allowedTools.has(tool)) return { allowed: false, reason: `Tool ${tool} not allowed in profile ${policy.profile}${policy.hardReadOnly ? " (hard read-only)" : ""}` };
  if (policy.requireApprovalFor.has(tool) && !dryRun) return { allowed: true, requiresApproval: true };
  return { allowed: true };
}

export function validateProfileConfig(profile: string, hardReadOnly: string): { profile: Profile; hardReadOnly: boolean } {
  const validProfiles: Profile[] = ["read", "core", "write", "advanced", "dev"];
  if (!validProfiles.includes(profile as Profile)) throw new Error(`Invalid profile: ${profile}. Must be one of: ${validProfiles.join(", ")}`);
  return { profile: profile as Profile, hardReadOnly: hardReadOnly !== "0" };
}