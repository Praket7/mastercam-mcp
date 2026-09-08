import { createHash } from "node:crypto";

export type SetupInput = { part?: Record<string, unknown>; machine?: Record<string, unknown>; stock?: Record<string, unknown>; wcs?: Record<string, unknown>; operations?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>; notes?: string[] };

export function setupSheet(input: SetupInput) {
  const operations = input.operations ?? [];
  const tools = input.tools ?? [];
  return { schema: "mastercam-mcp/setup-sheet/v1", generatedAt: new Date().toISOString(), part: input.part ?? {}, machine: input.machine ?? {}, stock: input.stock ?? {}, wcs: input.wcs ?? {}, tools, operations, notes: input.notes ?? [], review: { status: "draft", requiresApproval: true }, safety: "This document is evidence for review and does not prove machine safety" };
}

export function compareJson(left: unknown, right: unknown) {
  const a = JSON.stringify(left, null, 2)?.split("\n") ?? [];
  const b = JSON.stringify(right, null, 2)?.split("\n") ?? [];
  const changed = Math.max(a.length, b.length) - a.filter((line, i) => line === b[i]).length;
  return { equal: changed === 0, changedLines: changed, leftHash: hash(left), rightHash: hash(right), leftLines: a.length, rightLines: b.length };
}

export function compareNc(left: string, right: string) {
  const a = left.split(/\r?\n/).filter(Boolean);
  const b = right.split(/\r?\n/).filter(Boolean);
  const changes = [] as Array<{ line: number; before?: string; after?: string }>;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i] && changes.length < 200) changes.push({ line: i + 1, before: a[i], after: b[i] });
  const tools = (text: string) => [...new Set([...text.matchAll(/\bT(\d+)\b/gi)].map(match => Number(match[1])))].sort((x, y) => x - y);
  return { equal: changes.length === 0 && a.length === b.length, changedLines: changes.length, addedLines: Math.max(0, b.length - a.length), removedLines: Math.max(0, a.length - b.length), toolsBefore: tools(left), toolsAfter: tools(right), changes };
}

export function validateMachine(operation: Record<string, unknown>, profile: Record<string, unknown>) {
  const issues: Array<{ code: string; severity: "warning" | "error"; message: string }> = [];
  const feed = Number(operation.feed);
  const maxFeed = Number(profile.maxFeed);
  const speed = Number(operation.speed);
  const maxSpeed = Number(profile.maxSpindleSpeed);
  if (Number.isFinite(maxFeed) && Number.isFinite(feed) && feed > maxFeed) issues.push({ code: "FEED_EXCEEDS_MACHINE_LIMIT", severity: "error", message: "Operation feed exceeds the selected machine limit" });
  if (Number.isFinite(maxSpeed) && Number.isFinite(speed) && speed > maxSpeed) issues.push({ code: "SPEED_EXCEEDS_MACHINE_LIMIT", severity: "error", message: "Spindle speed exceeds the selected machine limit" });
  if (!profile.controller) issues.push({ code: "CONTROLLER_UNKNOWN", severity: "warning", message: "Controller is not defined so NC behavior is not fully verifiable" });
  if (!profile.holderFamily) issues.push({ code: "HOLDER_PROFILE_MISSING", severity: "warning", message: "Holder family is not defined so holder clearance is not verifiable" });
  return { valid: !issues.some(issue => issue.severity === "error"), verification: issues.length ? "review_required" : "fixture_only", issues };
}

export function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
