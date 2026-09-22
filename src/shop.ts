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

// ---- semantic JSON diff --------------------------------------------------

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

/** Semantic comparison independent of key order and formatting. */
export function compareJson(left: unknown, right: unknown): JsonDiffResult {
  const result: JsonDiffResult = { equal: true, added: [], removed: [], modified: [], unchangedCount: 0, leftHash: sha256Of(left), rightHash: sha256Of(right) };
  if (isPlainObject(left) && isPlainObject(right)) diffObjects(left, right, "", result);
  else if (Array.isArray(left) && Array.isArray(right)) diffArrays(left, right, "$", result);
  else if (canonical(left) !== canonical(right)) result.modified.push({ path: "$", before: left, after: right });
  else result.unchangedCount++;
  result.equal = result.added.length === 0 && result.removed.length === 0 && result.modified.length === 0;
  return result;
}

// ---- tool database comparison -------------------------------------------

export interface ToolDatabaseChange {
  identity: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  fields?: JsonDiffEntry[];
}

export interface ToolDatabaseDiffResult {
  equal: boolean;
  leftHash: string;
  rightHash: string;
  addedTools: ToolDatabaseChange[];
  removedTools: ToolDatabaseChange[];
  modifiedTools: ToolDatabaseChange[];
  unchangedTools: number;
  identityWarnings: string[];
}

function toolRecords(value: unknown): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(value)) return value.filter(isPlainObject);
  if (isPlainObject(value) && Array.isArray(value.tools)) return value.tools.filter(isPlainObject);
  return undefined;
}

function scalarIdentity(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toolIdentity(tool: Record<string, unknown>): string {
  for (const key of ["number", "toolNumber", "tool_number", "id", "guid", "geometryId", "vendorId"]) {
    const value = scalarIdentity(tool[key]);
    if (value !== undefined) return `${key}:${value}`;
  }
  return `content:${sha256Of(tool)}`;
}

function indexTools(tools: Array<Record<string, unknown>>, side: string, warnings: string[]) {
  const result = new Map<string, Record<string, unknown>>();
  const duplicateCounts = new Map<string, number>();
  for (const tool of tools) {
    const base = toolIdentity(tool);
    const count = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, count + 1);
    const identity = count === 0 ? base : `${base}#${count + 1}`;
    if (count > 0) warnings.push(`${side} contains duplicate tool identity ${base}; occurrence ${count + 1} was disambiguated by order`);
    result.set(identity, tool);
  }
  return result;
}

/**
 * Domain-aware tool database comparison. Tool order is ignored; matching is
 * based on stable tool identity and only then are fields compared.
 */
export function compareToolDatabases(left: unknown, right: unknown): ToolDatabaseDiffResult | JsonDiffResult {
  const leftTools = toolRecords(left);
  const rightTools = toolRecords(right);
  if (!leftTools || !rightTools) return compareJson(left, right);

  const identityWarnings: string[] = [];
  const leftIndex = indexTools(leftTools, "left database", identityWarnings);
  const rightIndex = indexTools(rightTools, "right database", identityWarnings);
  const identities = new Set([...leftIndex.keys(), ...rightIndex.keys()]);
  const addedTools: ToolDatabaseChange[] = [];
  const removedTools: ToolDatabaseChange[] = [];
  const modifiedTools: ToolDatabaseChange[] = [];
  let unchangedTools = 0;

  for (const identity of identities) {
    const before = leftIndex.get(identity);
    const after = rightIndex.get(identity);
    if (!before && after) { addedTools.push({ identity, after }); continue; }
    if (before && !after) { removedTools.push({ identity, before }); continue; }
    if (!before || !after) continue;
    const fieldDiff = compareJson(before, after);
    if (fieldDiff.equal) unchangedTools++;
    else modifiedTools.push({ identity, before, after, fields: [...fieldDiff.added, ...fieldDiff.removed, ...fieldDiff.modified] });
  }

  return {
    equal: addedTools.length === 0 && removedTools.length === 0 && modifiedTools.length === 0,
    leftHash: sha256Of(left),
    rightHash: sha256Of(right),
    addedTools,
    removedTools,
    modifiedTools,
    unchangedTools,
    identityWarnings
  };
}

// ---- NC sequence + modal semantic diff ----------------------------------

export type DiffOpType = "equal" | "insert" | "delete";
export interface DiffOp { type: DiffOpType; before?: string; after?: string; line: number }

/**
 * Myers diff producing edit-script ops. A one-line insertion no longer shifts
 * every later comparison the way an index-aligned loop would.
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
    const ops: DiffOp[] = a.map((line, i) => ({ type: "delete" as const, before: line, line: i + 1 }));
    ops.push(...b.map((line, i) => ({ type: "insert" as const, after: line, line: i + 1 })));
    return ops;
  }
  const raw: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const vd = trace[d];
    if (!vd) break;
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
  feedValues: number[];
  feedWords: number;
  rapidMoves: number;
  coolant: { on: number; off: number };
  coolantSequence: string[];
  compensationModes: string[];
  toolLengthCompensation: string[];
  cannedCycles: string[];
  safeRetracts: string[];
  programStops: number;
  optionalStops: number;
}

export interface NcSemanticDelta {
  toolChanges: number;
  feedChanges: number;
  spindleChanges: number;
  rapidMoves: number;
  rapidMoveChanges: number;
  workOffsetChanges: number;
  compensationChanges: number;
  toolLengthCompensationChanges: number;
  cannedCycleChanges: number;
  coolantChanges: number;
  safeRetractChanges: number;
  unitModeChanges: number;
  distanceModeChanges: number;
}

function stripNcComments(raw: string): string {
  return raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, " ").trim();
}

function numberWords(line: string, letter: string): number[] {
  const regex = new RegExp(`\\b${letter}([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`, "gi");
  return [...line.matchAll(regex)].map(match => Number(match[1])).filter(Number.isFinite);
}

export function summarizeNc(text: string): NcSemanticSummary {
  const summary: NcSemanticSummary = {
    workOffsets: [], toolChanges: [], spindleChanges: [], feedValues: [], feedWords: 0,
    rapidMoves: 0, coolant: { on: 0, off: 0 }, coolantSequence: [], compensationModes: [],
    toolLengthCompensation: [], cannedCycles: [], safeRetracts: [], programStops: 0, optionalStops: 0
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripNcComments(raw).toUpperCase();
    if (!line) continue;
    if (/\bG20\b/.test(line)) summary.units = "inch";
    if (/\bG21\b/.test(line)) summary.units = "mm";
    if (/\bG90\b/.test(line)) summary.absoluteMode = "absolute";
    if (/\bG91\b/.test(line)) summary.absoluteMode = "incremental";

    for (const match of line.matchAll(/\bG(?:5[4-9]|54\.1\s*P\d+)\b/g)) summary.workOffsets.push(match[0].replace(/\s+/g, " "));
    for (const value of numberWords(line, "T")) summary.toolChanges.push(value);
    for (const value of numberWords(line, "S")) summary.spindleChanges.push(value);
    const feeds = numberWords(line, "F");
    summary.feedValues.push(...feeds);
    summary.feedWords += feeds.length;
    if (/\bG0?0\b/.test(line)) summary.rapidMoves++;

    for (const match of line.matchAll(/\bM(7|8|9)\b/g)) {
      const code = `M${match[1]}`;
      summary.coolantSequence.push(code);
      if (code === "M9") summary.coolant.off++;
      else summary.coolant.on++;
    }
    for (const match of line.matchAll(/\bG4[012]\b/g)) summary.compensationModes.push(match[0]);
    for (const match of line.matchAll(/\bG4[349]\b/g)) summary.toolLengthCompensation.push(match[0]);
    for (const match of line.matchAll(/\bG8\d\b/g)) summary.cannedCycles.push(match[0]);
    for (const match of line.matchAll(/\bG(?:28|30|53)\b/g)) summary.safeRetracts.push(match[0]);
    if (/\bM0?0\b/.test(line)) summary.programStops++;
    if (/\bM0?1\b/.test(line)) summary.optionalStops++;
  }
  summary.spindleChanges = summary.spindleChanges.slice(0, 200);
  summary.feedValues = summary.feedValues.slice(0, 500);
  return summary;
}

function countSequenceChanges<T>(before: T[], after: T[]): number {
  let changes = 0;
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) if (before[i] !== after[i]) changes++;
  return changes;
}

function semanticDelta(before: NcSemanticSummary, after: NcSemanticSummary): NcSemanticDelta {
  return {
    toolChanges: countSequenceChanges(before.toolChanges, after.toolChanges),
    feedChanges: countSequenceChanges(before.feedValues, after.feedValues),
    spindleChanges: countSequenceChanges(before.spindleChanges, after.spindleChanges),
    rapidMoves: after.rapidMoves,
    rapidMoveChanges: Math.abs(after.rapidMoves - before.rapidMoves),
    workOffsetChanges: countSequenceChanges(before.workOffsets, after.workOffsets),
    compensationChanges: countSequenceChanges(before.compensationModes, after.compensationModes),
    toolLengthCompensationChanges: countSequenceChanges(before.toolLengthCompensation, after.toolLengthCompensation),
    cannedCycleChanges: countSequenceChanges(before.cannedCycles, after.cannedCycles),
    coolantChanges: countSequenceChanges(before.coolantSequence, after.coolantSequence),
    safeRetractChanges: countSequenceChanges(before.safeRetracts, after.safeRetracts),
    unitModeChanges: before.units === after.units ? 0 : 1,
    distanceModeChanges: before.absoluteMode === after.absoluteMode ? 0 : 1
  };
}

export interface NcDiffResult {
  equal: boolean;
  totalChangeCount: number;
  totalChanges: number;
  displayedChangeCount: number;
  displayedChanges: number;
  truncated: boolean;
  addedLines: number;
  removedLines: number;
  modifiedLines: number;
  toolsBefore: number[];
  toolsAfter: number[];
  changes: NcChange[];
  semantic: { before: NcSemanticSummary; after: NcSemanticSummary };
  semanticSummary: NcSemanticDelta;
}

function pairNcChanges(changes: NcChange[]): NcChange[] {
  const paired: NcChange[] = [];
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i];
    if (!current) continue;
    const next = changes[i + 1];
    const adjacent = next && Math.abs(next.line - current.line) <= 2;
    if (adjacent && current.kind === "removed" && next?.kind === "added") {
      paired.push({ line: Math.min(current.line, next.line), kind: "modified", before: current.before, after: next.after });
      i++;
    } else if (adjacent && current.kind === "added" && next?.kind === "removed") {
      paired.push({ line: Math.min(current.line, next.line), kind: "modified", before: next.before, after: current.after });
      i++;
    } else paired.push(current);
  }
  return paired;
}

/**
 * Sequence diff of NC files plus modal manufacturing semantics. Display
 * truncation is based on the paired change list, so a one-line replacement is
 * one displayed modification rather than a false truncation caused by its
 * underlying delete+insert edit script.
 */
export function compareNc(left: string, right: string, displayLimit = 200): NcDiffResult {
  const a = left.split(/\r?\n/).filter(line => line.trim().length > 0);
  const b = right.split(/\r?\n/).filter(line => line.trim().length > 0);
  const ops = sequenceDiff(a, b);
  const rawChanges: NcChange[] = [];
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "equal") continue;
    if (op.type === "insert") {
      added++;
      rawChanges.push({ line: op.line, kind: "added", after: op.after });
    } else {
      removed++;
      rawChanges.push({ line: op.line, kind: "removed", before: op.before });
    }
  }

  const paired = pairNcChanges(rawChanges);
  const limit = Math.max(0, Math.floor(displayLimit));
  const displayed = paired.slice(0, limit);
  const modified = paired.filter(change => change.kind === "modified").length;
  const beforeSummary = summarizeNc(left);
  const afterSummary = summarizeNc(right);
  const toolsBeforeArr = [...new Set(beforeSummary.toolChanges)].sort((x, y) => x - y);
  const toolsAfterArr = [...new Set(afterSummary.toolChanges)].sort((x, y) => x - y);
  const totalRawChanges = added + removed;

  return {
    equal: totalRawChanges === 0,
    totalChangeCount: totalRawChanges,
    totalChanges: totalRawChanges,
    displayedChangeCount: displayed.length,
    displayedChanges: displayed.length,
    truncated: paired.length > limit,
    addedLines: added,
    removedLines: removed,
    modifiedLines: modified,
    toolsBefore: toolsBeforeArr,
    toolsAfter: toolsAfterArr,
    changes: displayed,
    semantic: { before: beforeSummary, after: afterSummary },
    semanticSummary: semanticDelta(beforeSummary, afterSummary)
  };
}

// ---- machine profile validation -----------------------------------------

export interface ValidationCheck {
  name: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  severity: "warning" | "error" | "info";
  message?: string;
}

/** Explicit conversion that never turns "" or null into 0. */
export function strictNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function normalizeFeedMmMin(
  operation: Record<string, unknown>
): { value?: number; reason?: string } {
  const feedRate = recordOf(operation.feedRate);
  const rawValue = feedRate ? feedRate.value : operation.feed;
  const value = strictNumber(rawValue);
  if (value === undefined) return { reason: "Operation feed is missing" };

  const unit = typeof feedRate?.unit === "string" ? feedRate.unit : "mm/min";
  if (unit === "mm/min") return { value };
  if (unit === "in/min") return { value: value * 25.4 };

  if (unit === "mm/rev" || unit === "in/rev") {
    const spindle = recordOf(operation.spindleSpeed);
    const rpm =
      spindle?.unit === "rpm"
        ? strictNumber(spindle.value)
        : strictNumber(operation.speed);
    if (rpm === undefined || rpm <= 0) {
      return { reason: `Cannot convert ${unit} without spindle RPM` };
    }
    const perRevMm = unit === "in/rev" ? value * 25.4 : value;
    return { value: perRevMm * rpm };
  }

  return { reason: `Unsupported feed unit ${unit}` };
}

export function validateMachine(
  operation: Record<string, unknown>,
  profile: Record<string, unknown>
) {
  const checks: ValidationCheck[] = [];
  const profileFeed = recordOf(profile.feed);
  const profileSpindle = recordOf(profile.spindle);
  const controller = profile.controller;

  const maxFeed =
    strictNumber(profileFeed?.maxFeedMmMin) ??
    strictNumber(profile.maxFeed);
  const normalizedFeed = normalizeFeedMmMin(operation);

  if (maxFeed !== undefined) {
    if (normalizedFeed.value !== undefined) {
      const pass = normalizedFeed.value <= maxFeed;
      checks.push({
        name: "feed_limit",
        pass,
        expected: { maxFeedMmMin: maxFeed },
        actual: { feedMmMin: normalizedFeed.value },
        severity: pass ? "info" : "error",
        message: pass
          ? "Feed is within the declared machine limit"
          : `Operation feed ${normalizedFeed.value} mm/min exceeds machine limit ${maxFeed} mm/min`
      });
    } else {
      checks.push({
        name: "feed_limit",
        pass: false,
        expected: { maxFeedMmMin: maxFeed },
        severity: "warning",
        message: normalizedFeed.reason ?? "Feed could not be evaluated"
      });
    }
  }

  const spindle = recordOf(operation.spindleSpeed);
  const spindleValue = spindle ? strictNumber(spindle.value) : strictNumber(operation.speed);
  const spindleUnit = spindle && typeof spindle.unit === "string" ? spindle.unit : "rpm";
  const maxRpm =
    strictNumber(profileSpindle?.maxRpm) ??
    strictNumber(profile.maxSpindleSpeed);

  if (maxRpm !== undefined) {
    if (spindleValue === undefined) {
      checks.push({
        name: "spindle_limit",
        pass: false,
        expected: { maxRpm },
        severity: "warning",
        message: "Spindle speed is missing, so the machine RPM limit could not be checked"
      });
    } else if (spindleUnit !== "rpm") {
      checks.push({
        name: "spindle_limit",
        pass: false,
        expected: { maxRpm },
        actual: { value: spindleValue, unit: spindleUnit },
        severity: "warning",
        message: `Cannot compare ${spindleUnit} directly with an RPM machine limit`
      });
    } else {
      const pass = spindleValue <= maxRpm;
      checks.push({
        name: "spindle_limit",
        pass,
        expected: { maxRpm },
        actual: { rpm: spindleValue },
        severity: pass ? "info" : "error",
        message: pass
          ? "Spindle speed is within the declared machine limit"
          : `Spindle speed ${spindleValue} rpm exceeds machine limit ${maxRpm} rpm`
      });
    }
  }

  if (controller) {
    checks.push({
      name: "controller_configured",
      pass: true,
      actual: controller,
      severity: "info",
      message: "Controller information is present"
    });
  } else {
    checks.push({
      name: "controller_configured",
      pass: false,
      severity: "warning",
      message: "Controller is not defined, so NC behavior is not fully verifiable"
    });
  }

  const detailedTaper =
    profileSpindle && typeof profileSpindle.taper === "string"
      ? profileSpindle.taper
      : undefined;
  const legacyHolder =
    typeof profile.holderFamily === "string" ? profile.holderFamily : undefined;
  if (!detailedTaper && !legacyHolder) {
    checks.push({
      name: "holder_profile",
      pass: false,
      severity: "warning",
      message: "Holder or spindle taper information is missing, so holder compatibility is not verifiable"
    });
  }

  const errors = checks.filter(check => check.severity === "error").length;
  const warnings = checks.filter(check => check.severity === "warning").length;
  const info = checks.filter(check => check.severity === "info").length;

  return {
    valid: errors === 0,
    checks,
    summary: { errors, warnings, info }
  };
}

export function hash(value: unknown) { return sha256Of(value); }
