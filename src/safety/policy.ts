export type Profile = "read" | "core" | "write" | "advanced" | "dev" | "all";

export interface SafetyPolicy {
  profile: Profile;
  hardReadOnly: boolean;
  allowedTools: Set<string>;
  requireApprovalFor: Set<string>;
  dryRunAllowed: Set<string>;
}

const READ_TOOLS = new Set(["mastercam_status", "mastercam_capabilities", "get_active_part"]);
const WRITE_TOOLS = new Set(["apply_operation_parameter_preview", "rollback_change", "regenerate_toolpath"]);
const ADVANCED_TOOLS = new Set(["run_simulation", "detect_collisions"]);

export function createSafetyPolicy(profile: Profile, hardReadOnly: boolean): SafetyPolicy {
  const allowedTools = new Set<string>(READ_TOOLS);
  const requireApprovalFor = new Set<string>();
  const dryRunAllowed = new Set<string>(READ_TOOLS);
  // Map old profiles to new logic: core/write/advanced/dev all allow writes
  const canWrite = profile === "core" || profile === "write" || profile === "advanced" || profile === "dev" || profile === "all";
  const canAdvanced = profile === "advanced" || profile === "dev" || profile === "all";
  if (!hardReadOnly && canWrite) {
    for (const t of WRITE_TOOLS) { allowedTools.add(t); requireApprovalFor.add(t); }
  }
  if (!hardReadOnly && canAdvanced) {
    for (const t of ADVANCED_TOOLS) { allowedTools.add(t); requireApprovalFor.add(t); }
  }
  for (const t of [...WRITE_TOOLS, ...ADVANCED_TOOLS]) dryRunAllowed.add(t);
  return { profile, hardReadOnly, allowedTools, requireApprovalFor, dryRunAllowed };
}

export function checkToolAllowed(policy: SafetyPolicy, tool: string, dryRun: boolean): { allowed: boolean; reason?: string; requiresApproval?: boolean } {
  if (dryRun && policy.dryRunAllowed.has(tool)) return { allowed: true };
  if (!policy.allowedTools.has(tool)) return { allowed: false, reason: `Tool ${tool} not allowed` };
  if (policy.requireApprovalFor.has(tool) && !dryRun) return { allowed: true, requiresApproval: true };
  return { allowed: true };
}

export function validateProfileConfig(profile: string, _hardReadOnly: string): { profile: Profile; hardReadOnly: boolean } {
  const valid = ["read", "core", "write", "advanced", "dev", "all"] as const;
  if (!valid.includes(profile as any)) throw new Error(`Invalid profile: ${profile}`);
  return { profile: profile as Profile, hardReadOnly: _hardReadOnly !== "0" };
}
