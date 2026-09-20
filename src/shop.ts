import { sha256Of } from "./audit/audit-log.js";

export type SetupInput = {
  part?: Record<string, unknown>;
  machine?: Record<string, unknown>;
  stock?: Record<string, unknown>;
  wcs?: Record<string, unknown>;
  operations?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  notes?: string[];
};

export function setupSheet(input: SetupInput) {
  const operations = input.operations ?? [];
  const tools = input.tools ?? [];
  return {
    schema: "mastercam-mcp/setup-sheet/v1",
    generatedAt: new Date().toISOString(),
    part: input.part ?? {},
    machine: input.machine ?? {},
    stock: input.stock ?? {},
    wcs: input.wcs ?? {},
    tools,
    operations,
    notes: input.notes ?? [],
    review: { status: "draft", requiresApproval: true, approved: false },
    safety: "This document is evidence for review and does not prove machine safety",
    documentHash: sha256Of(input)
  };
}

// ---- semantic JSON diff (BUG-13 fix) ------------------------------------

export interface JsonDiffEntry { path: string; before?: unknown; after?: unknown }
export interface JsonDiffResult {
  equal: boolean;
  added: JsonDiffEntry[];
  removed: JsonDiffEntry[];
  modified: JsonDiffEntry[];
  unchangedCount: number;
  leftHash: string;
  rightHash: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diffObjects(left: Record<string, unknown>, right: Record<string, unknown>, prefix: string, out: JsonDiffResult): void {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = left[key];
    const b = right[key];
    if (!(key in left)) { out.added.push({ path, after: b }); continue; }
    if (!(key in right)) { out.removed.push({ path, before: a }); continue; }
    if (isPlainObject(a) && isPlainObject(b)) { diffObjects(a, b, path, out); continue; }
    if (Array.isArray(a) && Array.isArray(b)) { diffArrays(a, b, path, out); continue; }
    if (canonical(a) !== canonical(b)) out.modified.push({ path, before: a, after: b });
    else out.unchangedCount++;
  }
}

function diffArrays(left: unknown[], right: unknown[], prefix: string, out: JsonDiffResult): void {
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index++) {
    const path = `${prefix}.${index}`;
    const a = left[index];
    const b = right[index];
    if (index >= left.length) { out.added.push({ path, after: b }); continue; }
    if (index >= right.length) { out.removed.push({ path, before: a }); continue; }
    if (isPlainObject(a) && isPlainObject(b)) { diffObjects(a, b, path, out); continue; }
    if (Array.isArray(a) && Array.isArray(b)) { diffArrays(a, b, path, out); continue; }
    if (canonical(a) !== canonical(b)) out.modified.push({ path, before: a, after: b });
    else out.unchangedCount++;
  }
}

/** Key-order-independent canonical text for equality checks. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Semantic comparison independent of key order and formatting (BUG-13). */
export function compareJson(left: unknown, right: unknown): JsonDiffResult {
  const result: JsonDiffResult = { equal: true, added: [], removed: [], modified: [], unchangedCount: 0, leftHash: sha256Of(left), rightHash: sha256Of(right) };
  if (isPlainObject(left) && isPlainObject(right)) diffObjects(left, right, "", result);
  else if (canonical(left) !== canonical(right)) result.modified.push({ path: "$", before: left, after: right });
  else result.unchangedCount++;
  result.equal = result.added.length === 0 && result.removed.length === 0 && result.modified.length === 0;
  return result;
}

// ---- NC sequence diff (BUG-14 fix): real Myers O(ND) ---------------------

export type DiffOpType = "equal" | "insert" | "delete";
export interface DiffOp { type: DiffOpType; before?: string; after?: string; line: number }

/**
 * Myers diff producing edit-script ops. A one-line insertion no longer shifts
 * every later comparison the way the old index-aligned loop did.
 */
export function sequenceDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const trace: Array<Map<number, number>> = [];
  let v = new Map<number, number>([[1, 0]]);
  let foundD = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { foundD = d; break outer; }
    }
    v = new Map(v);
  }
  if (foundD < 0) {
    // Unreachable for finite inputs, but keep a safe fallback.
    const ops: DiffOp[] = a.map((line, i) => ({ type: "delete" as const, before: line, line: i + 1 }));
    ops.push(...b.map((line, i) => ({ type: "insert" as const, after: line, line: i + 1 })));
    return ops;
  }
  // Backtrack the edit script.
  const raw: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const vd = trace[d];
    if (!vd) break; // cannot happen for a d that was reached during the search
    const k = x - y;
    const prevK = (k === -d || (k !== d && (vd.get(k - 1) ?? 0) < (vd.get(k + 1) ?? 0))) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      raw.push({ type: "equal", before: a[x - 1], after: b[y - 1], line: y });
      x--; y--;
    }
    if (x === prevX) raw.push({ type: "insert", after: b[prevY], line: prevY + 1 });
    else raw.push({ type: "delete", before: a[prevX], line: prevX + 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    if (a[x - 1] === b[y - 1]) { raw.push({ type: "equal", before: a[x - 1], after: b[y - 1], line: y }); x--; y--; }
    else { raw.push({ type: "delete", before: a[x - 1], line: x }); x--; }
  }
  while (x > 0) { raw.push({ type: "delete", before: a[x - 1], line: x }); x--; }
  while (y > 0) { raw.push({ type: "insert", after: b[y - 1], line: y }); y--; }
  return raw.reverse();
}

export interface NcChange { line: number; kind: "added" | "removed" | "modified"; before?: string; after?: string }

export interface NcSemanticSummary {
  units?: "mm" | "inch";
  absoluteMode?: "absolute" | "incremental";
  workOffsets: string[];
  toolChanges: number[];
  spindleChanges: number[];
  feedWords: number;
  rapidMoves: number;
  coolant: { on: number; off: number };
  programStops: number;
  optionalStops: number;
}

export function summarizeNc(text: string): NcSemanticSummary {
  const summary: NcSemanticSummary = { workOffsets: [], toolChanges: [], spindleChanges: [], feedWords: 0, rapidMoves: 0, coolant: { on: 0, off: 0 }, programStops: 0, optionalStops: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/\bG20\b/i.test(line)) summary.units = "inch";
    if (/\bG21\b/i.test(line)) summary.units = "mm";
    if (/\bG90\b/i.test(line)) summary.absoluteMode = "absolute";
    if (/\bG91\b/i.test(line)) summary.absoluteMode = "incremental";
    const offset = line.match(/\bG5[4-9]\b/i);
    if (offset) summary.workOffsets.push(offset[0].toUpperCase());
    const tool = line.match(/\bT(\d+)\b/i);
    if (tool) summary.toolChanges.push(Number(tool[1]));
    const speed = line.match(/\bS(\d+)\b/i);
    if (speed) summary.spindleChanges.push(Number(speed[1]));
    if (/\bF\d/i.test(line)) summary.feedWords++;
    if (/\bG0\b/i.test(line)) summary.rapidMoves++;
    if (/\bM8\b/i.test(line)) summary.coolant.on++;
    if (/\bM9\b/i.test(line)) summary.coolant.off++;
    if (/\bM0\b/i.test(line)) summary.programStops++;
    if (/\bM1\b/i.test(line)) summary.optionalStops++;
  }
  summary.workOffsets = [...new Set(summary.workOffsets)];
  summary.toolChanges = [...new Set(summary.toolChanges)];
  summary.spindleChanges = summary.spindleChanges.slice(0, 50);
  return summary;
}

export interface NcDiffResult {
  equal: boolean;
  totalChangeCount: number;
  displayedChangeCount: number;
  truncated: boolean;
  addedLines: number;
  removedLines: number;
  modifiedLines: number;
  toolsBefore: number[];
  toolsAfter: number[];
  changes: NcChange[];
  semantic: { before: NcSemanticSummary; after: NcSemanticSummary };
}

/**
 * Sequence diff of NC files with semantic summary (BUG-14 + section 36).
 * `displayLimit` bounds the returned change list while totalChangeCount
 * still reports the truth about how many changes exist.
 */
export function compareNc(left: string, right: string, displayLimit = 200): NcDiffResult {
  const a = left.split(/\r?\n/).filter(line => line.trim().length > 0);
  const b = right.split(/\r?\n/).filter(line => line.trim().length > 0);
  const ops = sequenceDiff(a, b);
  const changes: NcChange[] = [];
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "equal") continue;
    if (op.type === "insert") {
      added++;
      if (changes.length < displayLimit) changes.push({ line: op.line, kind: "added", after: op.after });
    } else {
      removed++;
      if (changes.length < displayLimit) changes.push({ line: op.line, kind: "removed", before: op.before });
    }
  }
  // Pair a removal with the insertion that replaced it as a modification.
  const paired: NcChange[] = [];
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i];
    if (!current) continue;
    const next = changes[i + 1];
    if (current.kind === "removed" && next && next.kind === "added" && next.line >= current.line && next.line - current.line <= 2) {
      paired.push({ line: current.line, kind: "modified", before: current.before, after: next.after });
      i++;
    } else paired.push(current);
  }
  const modified = paired.filter(change => change.kind === "modified").length;
  return {
    equal: added === 0 && removed === 0,
    totalChangeCount: added + removed,
    displayedChangeCount: paired.length,
    truncated: added + removed > paired.length,
    addedLines: added,
    removedLines: removed,
    modifiedLines: modified,
    toolsBefore: summarizeNc(left).toolChanges,
    toolsAfter: summarizeNc(right).toolChanges,
    changes: paired,
    semantic: { before: summarizeNc(left), after: summarizeNc(right) }
  };
}

// ---- machine profile validation (section 37) ----------------------------

export interface ValidationIssue { code: string; severity: "warning" | "error"; message: string }

/** Explicit conversion that never turns "" or null into 0 (section 37). */
export function strictNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function validateMachine(operation: Record<string, unknown>, profile: Record<string, unknown>) {
  const issues: ValidationIssue[] = [];
  const feedValue = operation.feedRate && typeof operation.feedRate === "object" ? (operation.feedRate as { value?: unknown }).value : operation.feed;
  const feed = strictNumber(feedValue);
  const maxFeed = strictNumber(profile.maxFeed);
  const speedValue = operation.spindleSpeed && typeof operation.spindleSpeed === "object" ? (operation.spindleSpeed as { value?: unknown }).value : operation.speed;
  const speed = strictNumber(speedValue);
  const maxSpeed = strictNumber(profile.maxSpindleSpeed);

  if (maxFeed !== undefined && feed !== undefined && feed > maxFeed) {
    issues.push({ code: "FEED_EXCEEDS_MACHINE_LIMIT", severity: "error", message: `Operation feed ${feed} exceeds the machine limit ${maxFeed}` });
  }
  if (maxSpeed !== undefined && speed !== undefined && speed > maxSpeed) {
    issues.push({ code: "SPEED_EXCEEDS_MACHINE_LIMIT", severity: "error", message: `Spindle speed ${speed} exceeds the machine limit ${maxSpeed}` });
  }
  if (maxFeed !== undefined && feed === undefined) {
    issues.push({ code: "FEED_UNKNOWN", severity: "warning", message: "Operation feed is missing so the machine feed limit could not be checked" });
  }
  if (maxSpeed !== undefined && speed === undefined) {
    issues.push({ code: "SPEED_UNKNOWN", severity: "warning", message: "Spindle speed is missing so the machine speed limit could not be checked" });
  }
  if (!profile.controller) issues.push({ code: "CONTROLLER_UNKNOWN", severity: "warning", message: "Controller is not defined so NC behavior is not fully verifiable" });
  if (!profile.holderFamily) issues.push({ code: "HOLDER_PROFILE_MISSING", severity: "warning", message: "Holder family is not defined so holder clearance is not verifiable" });
  const travels = profile.axisTravels;
  if (travels !== undefined && !isPlainObject(travels)) {
    issues.push({ code: "PROFILE_MALFORMED", severity: "error", message: "axisTravels must be an object of per-axis limits" });
  }
  const workOffsets = profile.permittedWorkOffsets;
  if (workOffsets !== undefined && !Array.isArray(workOffsets)) {
    issues.push({ code: "PROFILE_MALFORMED", severity: "error", message: "permittedWorkOffsets must be an array" });
  }
  return { valid: !issues.some(issue => issue.severity === "error"), verification: issues.length ? "review_required" : "fixture_only", issues };
}

export function hash(value: unknown) { return sha256Of(value); }
