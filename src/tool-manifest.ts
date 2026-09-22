import { z } from "zod";
import type { CapabilityTier } from "./contracts.js";
import type { ToolDefinition } from "./mcp/registry.js";
import { categoryOf } from "./mcp/registry.js";

export interface ToolManifest {
  name: string;
  risk: "read" | "preview" | "mutation" | "advanced";
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  mockSupport: boolean;
  legacySupport: boolean;
  mc2027Support: boolean;
  requiresExactTarget: boolean;
  requiresApproval: boolean;
  requiresRegeneration: boolean;
  tier: CapabilityTier;
  tierEvidence?: string;
}

export function manifestFromDefinition(definition: ToolDefinition): ToolManifest {
  const annotations = definition.annotations;
  const risk = annotations.readOnlyHint === true
    ? "read"
    : annotations.destructiveHint === true
      ? "mutation"
      : "advanced";
  return {
    name: definition.name,
    risk,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    mockSupport: true,
    legacySupport: false,
    mc2027Support: false,
    requiresExactTarget: true,
    requiresApproval: annotations.destructiveHint === true,
    requiresRegeneration: false,
    tier: "IMPLEMENTED",
  };
}

export function tierForTool(name: string): CapabilityTier {
  const category = categoryOf(name);
  if (category === "forbidden") return "UNAVAILABLE";
  if (category === "advanced") return "IMPLEMENTED";
  if (category === "read" || category === "preview") return "IMPLEMENTED";
  return "IMPLEMENTED";
}

export function riskForTool(name: string): ToolManifest["risk"] {
  const category = categoryOf(name);
  if (category === "read" || category === "preview") return "read";
  if (category === "write") return "mutation";
  return "advanced";
}

export function requiresApprovalForTool(name: string): boolean {
  const category = categoryOf(name);
  return category === "write" || category === "advanced";
}

export function requiresExactTargetForTool(_name: string): boolean {
  return true;
}
