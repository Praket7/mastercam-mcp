import * as z from "zod/v4";
import { sha256Of } from "./audit/audit-log.js";
import { compareNc } from "./shop.js";

const ManufacturingRecord = z.record(z.string(), z.unknown());

export const ManufacturingPreflightSchema = z.object({
  part: ManufacturingRecord.optional(),
  machine: ManufacturingRecord.optional(),
  stock: ManufacturingRecord.optional(),
  wcs: ManufacturingRecord.optional(),
  post: ManufacturingRecord.optional(),
  operations: z.array(ManufacturingRecord).max(500).default([]),
  tools: z.array(ManufacturingRecord).max(500).default([]),
  documentRevision: z.string().min(1).max(256).optional(),
  verification: z.object({
    simulationPassed: z.boolean().optional(),
    collisionCheckPassed: z.boolean().optional(),
    approvedPostBaselineAvailable: z.boolean().optional()
  }).strict().optional()
}).strict();

export const RegenerationImpactSchema = z.object({
  operations: z.array(z.object({
    id: z.union([z.number().int(), z.string().min(1).max(128)]),
    name: z.string().max(256).optional(),
    dependencies: z.array(z.union([z.number().int(), z.string().min(1).max(128)])).max(500).default([]),
    toolpathDirty: z.boolean().optional()
  }).strict()).max(500),
  changedOperationIds: z.array(z.union([z.number().int(), z.string().min(1).max(128)])).min(1).max(500)
}).strict();

export const PostRegressionSchema = z.object({
  before: z.string().min(1).max(2_000_000),
  after: z.string().min(1).max(2_000_000),
  displayLimit: z.number().int().min(0).max(1000).default(200)
}).strict();

export type PreflightSeverity = "blocker" | "warning" | "pass" | "unknown";

export interface PreflightCheck {
  id: string;
  severity: PreflightSeverity;
  message: string;
  evidence?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstDefined(record: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).length > 0) {
      return record[key];
    }
  }
  return undefined;
}

function stableId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value)) {
    const nested = firstDefined(value, ["number", "toolNumber", "id", "guid"]);
    return stableId(nested);
  }
  return undefined;
}

function hasValue(record: Record<string, unknown>, keys: string[]): boolean {
  return firstDefined(record, keys) !== undefined;
}

export function manufacturingPreflight(input: z.infer<typeof ManufacturingPreflightSchema>) {
  const checks: PreflightCheck[] = [];
  const operations = input.operations ?? [];
  const tools = input.tools ?? [];

  const add = (id: string, severity: PreflightSeverity, message: string, evidence?: unknown) => {
    checks.push({ id, severity, message, ...(evidence === undefined ? {} : { evidence }) });
  };

  if (input.part && hasValue(input.part, ["name", "path", "fileName"])) {
    add("active_part", "pass", "Part identity is present");
  } else {
    add("active_part", "unknown", "Part identity was not supplied, so document identity cannot be verified");
  }

  if (operations.length === 0) {
    add("operations_present", "blocker", "No machining operations were supplied for preflight");
  } else {
    add("operations_present", "pass", `${operations.length} operation(s) are present`);
  }

  const dirty = operations.filter(operation =>
    operation.toolpathDirty === true ||
    operation.dirty === true ||
    operation.needsRegeneration === true
  );
  if (dirty.length > 0) {
    add(
      "dirty_toolpaths",
      "blocker",
      `${dirty.length} operation(s) require regeneration before the programming state is current`,
      dirty.slice(0, 100).map(operation => ({
        id: firstDefined(operation, ["id", "operationId"]),
        name: firstDefined(operation, ["name"])
      }))
    );
  } else if (operations.length > 0) {
    add("dirty_toolpaths", "pass", "No supplied operation is marked dirty");
  }

  for (const [id, value, label] of [
    ["machine_context", input.machine, "Machine definition"],
    ["stock_context", input.stock, "Stock definition"],
    ["wcs_context", input.wcs, "Work coordinate system"],
    ["post_context", input.post, "Post processor"]
  ] as const) {
    if (value && Object.keys(value).length > 0) add(id, "pass", `${label} is present`);
    else add(id, "unknown", `${label} was not supplied and cannot be verified`);
  }

  const toolIds = new Map<string, number>();
  for (const tool of tools) {
    const id = stableId(firstDefined(tool, ["number", "toolNumber", "id", "guid"]));
    if (!id) continue;
    toolIds.set(id, (toolIds.get(id) ?? 0) + 1);
  }
  const duplicates = [...toolIds.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    add("duplicate_tools", "warning", "Duplicate stable tool identities were supplied", duplicates.slice(0, 100));
  } else if (tools.length > 0) {
    add("duplicate_tools", "pass", "Supplied tools have unique stable identities");
  } else {
    add("tool_library", "unknown", "No tool records were supplied");
  }

  const unresolvedTools: Array<{ operationId?: unknown; tool: string }> = [];
  for (const operation of operations) {
    const tool = stableId(firstDefined(operation, ["tool", "toolNumber", "toolId"]));
    if (tool && tools.length > 0 && !toolIds.has(tool)) {
      unresolvedTools.push({
        operationId: firstDefined(operation, ["id", "operationId"]),
        tool
      });
    }
  }
  if (unresolvedTools.length > 0) {
    add(
      "tool_resolution",
      "blocker",
      `${unresolvedTools.length} operation tool reference(s) do not resolve against the supplied tool set`,
      unresolvedTools.slice(0, 100)
    );
  } else if (tools.length > 0 && operations.length > 0) {
    add("tool_resolution", "pass", "Operation tool references resolve against the supplied tool set");
  }

  const missingFeeds = operations.filter(operation => !hasValue(operation, ["feed", "feedRate"]));
  const missingSpindles = operations.filter(operation => !hasValue(operation, ["speed", "spindleSpeed", "rpm"]));
  if (missingFeeds.length > 0) {
    add("feed_completeness", "warning", `${missingFeeds.length} operation(s) have no supplied feed value`);
  } else if (operations.length > 0) {
    add("feed_completeness", "pass", "Every supplied operation contains a feed value");
  }
  if (missingSpindles.length > 0) {
    add("spindle_completeness", "warning", `${missingSpindles.length} operation(s) have no supplied spindle value`);
  } else if (operations.length > 0) {
    add("spindle_completeness", "pass", "Every supplied operation contains a spindle value");
  }

  const verificationChecks: Array<[string, boolean | undefined, string]> = [
    ["simulation", input.verification?.simulationPassed, "Simulation"],
    ["collision_check", input.verification?.collisionCheckPassed, "Collision check"]
  ];
  for (const [id, value, label] of verificationChecks) {
    if (value === true) add(id, "pass", `${label} is reported as passed`);
    else if (value === false) add(id, "blocker", `${label} is explicitly reported as failed`);
    else add(id, "unknown", `${label} evidence was not supplied`);
  }

  if (input.verification?.approvedPostBaselineAvailable === true) {
    add("post_baseline", "pass", "An approved NC/post baseline is reported as available");
  } else if (input.verification?.approvedPostBaselineAvailable === false) {
    add("post_baseline", "warning", "No approved NC/post baseline is available for regression comparison");
  } else {
    add("post_baseline", "unknown", "Approved NC/post baseline availability was not supplied");
  }

  const summary = {
    blockers: checks.filter(check => check.severity === "blocker").length,
    warnings: checks.filter(check => check.severity === "warning").length,
    unknown: checks.filter(check => check.severity === "unknown").length,
    passed: checks.filter(check => check.severity === "pass").length
  };

  const status = summary.blockers > 0
    ? "BLOCKED"
    : summary.warnings > 0 || summary.unknown > 0
      ? "REVIEW"
      : "READY_FOR_REVIEW";

  return {
    schema: "mastercam-mcp/manufacturing-preflight/v1",
    status,
    summary,
    checks,
    documentRevision: input.documentRevision,
    evidenceHash: sha256Of(input),
    safety: "Preflight is deterministic review evidence. It does not prove machine safety or authorize posting, transfer, or cycle start."
  };
}

export function analyzeRegenerationImpact(input: z.infer<typeof RegenerationImpactSchema>) {
  const byId = new Map<string, (typeof input.operations)[number]>();
  for (const operation of input.operations) byId.set(String(operation.id), operation);

  const changed = new Set(input.changedOperationIds.map(String));
  const unresolved = new Set<string>();
  const dependents = new Map<string, Set<string>>();
  for (const operation of input.operations) {
    const operationId = String(operation.id);
    for (const dependency of operation.dependencies) {
      const dependencyId = String(dependency);
      if (!byId.has(dependencyId)) unresolved.add(dependencyId);
      const children = dependents.get(dependencyId) ?? new Set<string>();
      children.add(operationId);
      dependents.set(dependencyId, children);
    }
  }

  const impacted = new Set<string>();
  const direct = new Set<string>();
  const queue: string[] = [];
  for (const changedId of changed) {
    for (const child of dependents.get(changedId) ?? []) {
      direct.add(child);
      if (!impacted.has(child)) {
        impacted.add(child);
        queue.push(child);
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of dependents.get(current) ?? []) {
      if (impacted.has(child)) continue;
      impacted.add(child);
      queue.push(child);
    }
  }

  const dirtyImpacted = [...impacted].filter(id => byId.get(id)?.toolpathDirty === true);
  const changedMissing = [...changed].filter(id => !byId.has(id));

  return {
    schema: "mastercam-mcp/regeneration-impact/v1",
    changedOperationIds: [...changed],
    directlyDependentOperationIds: [...direct],
    transitivelyImpactedOperationIds: [...impacted],
    dirtyImpactedOperationIds: dirtyImpacted,
    unresolvedDependencyIds: [...unresolved],
    changedOperationIdsNotFound: changedMissing,
    requiresReview: impacted.size > 0 || unresolved.size > 0 || changedMissing.length > 0,
    evidenceHash: sha256Of(input),
    note: "Impact is derived only from the supplied dependency graph. A live Mastercam dependency graph must be read from a verified release adapter before this can describe an active document."
  };
}

export function analyzePostRegression(input: z.infer<typeof PostRegressionSchema>) {
  const diff = compareNc(input.before, input.after, input.displayLimit);
  const semantic = diff.semanticSummary;
  const reasons: string[] = [];
  let score = 0;

  if (semantic.unitModeChanged) { score += 100; reasons.push("Units mode changed"); }
  if (semantic.positioningModeChanged) { score += 100; reasons.push("Absolute/incremental positioning mode changed"); }
  if (semantic.workOffsetChanges > 0) { score += 60; reasons.push(`${semantic.workOffsetChanges} work-offset event change(s)`); }
  if (semantic.compensationChanges > 0) { score += 50; reasons.push(`${semantic.compensationChanges} compensation event change(s)`); }
  if (semantic.toolChanges > 0) { score += 40; reasons.push(`${semantic.toolChanges} tool sequence change(s)`); }
  if (semantic.spindleChanges > 0) { score += 25; reasons.push(`${semantic.spindleChanges} spindle value change(s)`); }
  if (semantic.feedChanges > 0) { score += 25; reasons.push(`${semantic.feedChanges} feed value change(s)`); }
  if (semantic.retractChanges > 0) { score += 25; reasons.push(`${semantic.retractChanges} retract/safe-motion event change(s)`); }
  if (semantic.planeChanged) { score += 25; reasons.push("Active plane changed"); }
  if (semantic.cannedCycleChanged) { score += 20; reasons.push("Canned-cycle mode changed"); }
  if (semantic.coolantChanges > 0) { score += 10; reasons.push(`${semantic.coolantChanges} coolant event change(s)`); }
  if (semantic.rapidMoveDelta !== 0) { score += 10; reasons.push(`Rapid move count changed by ${semantic.rapidMoveDelta}`); }
  if (diff.totalChangeCount > 0 && reasons.length === 0) reasons.push("Textual NC changes were detected without a recognized modal/process change");

  const risk = diff.equal
    ? "NONE"
    : score >= 100
      ? "CRITICAL"
      : score >= 50
        ? "HIGH"
        : score >= 20
          ? "MEDIUM"
          : "LOW";

  return {
    schema: "mastercam-mcp/post-regression/v1",
    risk,
    requiresHumanReview: !diff.equal,
    reasons,
    semanticSummary: semantic,
    diff,
    baselineHash: sha256Of(input.before),
    candidateHash: sha256Of(input.after),
    safety: "Semantic regression analysis is review evidence only. It does not prove collision freedom, controller correctness, or machine safety."
  };
}
