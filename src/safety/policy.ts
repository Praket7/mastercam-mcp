import { allowed, type Profile } from "../contracts.js";
import { TOOL_MANIFEST } from "../tool-manifest.js";

export type { Profile };

export function parseHardReadOnly(value: string | undefined): boolean {
  return value !== "0";
}

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

  for (const entry of TOOL_MANIFEST) {
    if (!entry.registered) continue;
    if (allowed(entry.name, profile, hardReadOnly)) allowedTools.add(entry.name);
    if (entry.requiresApproval) requireApprovalFor.add(entry.name);
    if (entry.category === "read" || entry.category === "preview") dryRunAllowed.add(entry.name);
  }

  return { profile, hardReadOnly, allowedTools, requireApprovalFor, dryRunAllowed };
}

export function checkToolAllowed(
  policy: SafetyPolicy,
  tool: string,
  dryRun: boolean
): { allowed: boolean; reason?: string; requiresApproval?: boolean } {
  if (dryRun && policy.dryRunAllowed.has(tool)) return { allowed: true };
  if (!policy.allowedTools.has(tool)) return { allowed: false, reason: `Tool ${tool} not allowed` };
  if (policy.requireApprovalFor.has(tool) && !dryRun) return { allowed: true, requiresApproval: true };
  return { allowed: true };
}

export function validateProfileConfig(profile: string, hardReadOnly: string): { profile: Profile; hardReadOnly: boolean } {
  const valid = ["read", "write", "all"] as const;
  if (!valid.includes(profile as (typeof valid)[number])) {
    throw new Error(`Invalid profile: ${profile}. Valid profiles: ${valid.join(", ")}`);
  }
  return { profile: profile as Profile, hardReadOnly: parseHardReadOnly(hardReadOnly) };
}
