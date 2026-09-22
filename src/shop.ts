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
  else if (canonical(left) !== canonical(right)) result.modified.push({ path: "$", before: left, after: right });
  else result.unchangedCount++;
  result.equal = result.added.length === 0 && result.removed.length === 0 && result.modified.length === 0;
  return result;
}

export interface ToolDatabaseDiffResult extends JsonDiffResult {
  strategy: "stable-tool-identity";
  orderingChanged: boolean;
  duplicateIdentities: { left: string[]; right: string[] };
}

function toolIdentity(value: unknown): string {
  if (!isPlainObject(value)) return `value:${canonical(value)}`;
  const priorityFields: string[][] = [
    ["number"],
    ["toolNumber"],
    ["id"],
    ["guid"],
    ["vendorId", "geometryId"],
    ["name"]
  ];
  for (const fields of priorityFields) {
    const entries = fields
      .map(field => [field, value[field]] as const)
      .filter(([, fieldValue]) => fieldValue !== undefined && fieldValue !== null && String(fieldValue).length > 0);
    if (entries.length === fields.length) {
      return entries.map(([field, fieldValue]) => `${field}:${String(fieldValue)}`).join("|");
    }
  }
  return `value:${sha256Of(value)}`;
}

function duplicateToolIdentities(tools: unknown[]): string[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const key = toolIdentity(tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort();
}

function normalizeToolDatabase(value: unknown): { value: unknown; originalOrder: string[]; duplicates: string[] } {
  if (!isPlainObject(value) || !Array.isArray(value.tools)) {
    return { value, originalOrder: [], duplicates: [] };
  }
  const originalOrder = value.tools.map(toolIdentity);
  const normalizedTools = [...value.tools].sort((left, right) => {
    const leftKey = toolIdentity(left);
    const rightKey = toolIdentity(right);
    if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
    return canonical(left).localeCompare(canonical(right));
  });
  return {
    value: { ...value, tools: normalizedTools },
    originalOrder,
    duplicates: duplicateToolIdentities(value.tools)
  };
}

/**
 * Tool databases are collections, not ordered JSON arrays. Stable tool identity
 * is used before field-level comparison so reordering alone is not reported as
 * a manufacturing change.
 */
export function compareToolDatabases(left: unknown, right: unknown): ToolDatabaseDiffResult {
  const normalizedLeft = normalizeToolDatabase(left);
  const normalizedRight = normalizeToolDatabase(right);
  const result = compareJson(normalizedLeft.value, normalizedRight.value);
  return {
    ...result,
    strategy: "stable-tool-identity",
    orderingChanged:
      normalizedLeft.originalOrder.length > 0 &&
      normalizedRight.originalOrder.length > 0 &&
      canonical(normalizedLeft.originalOrder) !== canonical(normalizedRight.originalOrder),
    duplicateIdentities: {
      left: normalizedLeft.duplicates,
      right: normalizedRight.duplicates
    }
  };
}

// ---- NC sequence diff: Myers O(ND) --------------------------------------

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
  plane?: "G17" | "G18" | "G19";
  cutterComp?: "G40" | "G41" | "G42";
  toolLengthComp?: "G43" | "G49";
  cannedCycle?: string;
  workOffsets: string[];
  workOffsetEvents: string[];
  toolChanges: number[];
  spindleChanges: number[];
  feedValues: number[];
  compensationEvents: string[];
  coolantEvents: string[];
  retractEvents: string[];
  feedWords: number;
  rapidMoves: number;
  coolant: { on: number; off: number };
  programStops: number;
  optionalStops: number;
}

function stripNcComments(raw: string): string {
  return raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, " ").trim();
}

function allMatches(line: string, expression: RegExp): string[] {
  return [...line.matchAll(expression)].map(match => match[0].toUpperCase());
}

export function summarizeNc(text: string): NcSemanticSummary {
  const summary: NcSemanticSummary = {
    workOffsets: [],
    workOffsetEvents: [],
    toolChanges: [],
    spindleChanges: [],
    feedValues: [],
    compensationEvents: [],
    coolantEvents: [],
    retractEvents: [],
    feedWords: 0,
    rapidMoves: 0,
    coolant: { on: 0, off: 0 },
    programStops: 0,
    optionalStops: 0
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripNcComments(raw);
    if (!line) continue;

    if (/\bG20(?:\.0+)?\b/i.test(line)) summary.units = "inch";
    if (/\bG21(?:\.0+)?\b/i.test(line)) summary.units = "mm";
    if (/\bG90(?:\.0+)?\b/i.test(line)) summary.absoluteMode = "absolute";
    if (/\bG91(?:\.0+)?\b/i.test(line)) summary.absoluteMode = "incremental";

    const plane = line.match(/\bG1[789](?:\.0+)?\b/i)?.[0]?.toUpperCase();
    if (plane === "G17" || plane === "G18" || plane === "G19") summary.plane = plane;

    const workOffsets = allMatches(line, /\bG5[4-9](?:\.0+)?\b/gi);
    const extendedOffsets = [...line.matchAll(/\bG54\.1\s*P\s*(\d+)\b/gi)].map(match => `G54.1 P${match[1]}`.toUpperCase());
    for (const offset of [...workOffsets, ...extendedOffsets]) {
      summary.workOffsetEvents.push(offset);
      if (!summary.workOffsets.includes(offset)) summary.workOffsets.push(offset);
    }

    const tool = line.match(/\bT\s*(\d+)\b/i);
    if (tool) summary.toolChanges.push(Number(tool[1]));

    for (const match of line.matchAll(/\bS\s*(-?\d+(?:\.\d+)?)\b/gi)) {
      summary.spindleChanges.push(Number(match[1]));
    }
    for (const match of line.matchAll(/\bF\s*(-?\d+(?:\.\d+)?)\b/gi)) {
      summary.feedWords++;
      summary.feedValues.push(Number(match[1]));
    }

    if (/\bG0?0(?:\.0+)?\b/i.test(line)) summary.rapidMoves++;

    for (const code of allMatches(line, /\bG4[012](?:\.0+)?\b/gi)) {
      summary.cutterComp = code as "G40" | "G41" | "G42";
      summary.compensationEvents.push(code);
    }
    for (const code of allMatches(line, /\bG4[39](?:\.0+)?\b/gi)) {
      summary.toolLengthComp = code as "G43" | "G49";
      summary.compensationEvents.push(code);
    }

    const cycle = line.match(/\bG8[0-9](?:\.\d+)?\b/i)?.[0]?.toUpperCase();
    if (cycle) summary.cannedCycle = cycle;

    for (const code of allMatches(line, /\bM0?[789](?:\.0+)?\b/gi)) {
      const normalized = code.replace(/^M0(?=\d$)/, "M");
      summary.coolantEvents.push(normalized);
      if (normalized === "M7" || normalized === "M8") summary.coolant.on++;
      if (normalized === "M9") summary.coolant.off++;
    }

    for (const code of allMatches(line, /\bG(?:28|30|53)(?:\.0+)?\b/gi)) {
      summary.retractEvents.push(code);
    }

    if (/\bM0?0(?:\.0+)?\b/i.test(line)) summary.programStops++;
    if (/\bM0?1(?:\.0+)?\b/i.test(line)) summary.optionalStops++;
  }
  summary.spindleChanges = summary.spindleChanges.slice(0, 1000);
  summary.feedValues = summary.feedValues.slice(0, 1000);
  return summary;
}

export interface NcSemanticDiffSummary {
  toolChanges: number;
  feedChanges: number;
  spindleChanges: number;
  rapidMoves: number;
  rapidMoveDelta: number;
  workOffsetChanges: number;
  compensationChanges: number;
  coolantChanges: number;
  retractChanges: number;
  unitModeChanged: boolean;
  positioningModeChanged: boolean;
  planeChanged: boolean;
  cannedCycleChanged: boolean;
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
  semanticSummary: NcSemanticDiffSummary;
}

function pairNcChanges(changes: NcChange[]): NcChange[] {
  const paired: NcChange[] = [];
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i];
    if (!current) continue;
    const next = changes[i + 1];
    if (
      current.kind === "removed" &&
      next?.kind === "added" &&
      next.line >= current.line &&
      next.line - current.line <= 2
    ) {
      paired.push({ line: current.line, kind: "modified", before: current.before, after: next.after });
      i++;
    } else {
      paired.push(current);
    }
  }
  return paired;
}

function sequenceChangeCount(left: Array<string | number>, right: Array<string | number>): number {
  const leftText = left.map(String);
  const rightText = right.map(String);
  const raw = sequenceDiff(leftText, rightText)
    .filter(op => op.type !== "equal")
    .map<NcChange>(op =>
      op.type === "insert"
        ? { line: op.line, kind: "added", after: op.after }
        : { line: op.line, kind: "removed", before: op.before }
    );
  return pairNcChanges(raw).length;
}

function semanticDifference(before: NcSemanticSummary, after: NcSemanticSummary): NcSemanticDiffSummary {
  return {
    toolChanges: sequenceChangeCount(before.toolChanges, after.toolChanges),
    feedChanges: sequenceChangeCount(before.feedValues, after.feedValues),
    spindleChanges: sequenceChangeCount(before.spindleChanges, after.spindleChanges),
    rapidMoves: after.rapidMoves,
    rapidMoveDelta: after.rapidMoves - before.rapidMoves,
    workOffsetChanges: sequenceChangeCount(before.workOffsetEvents, after.workOffsetEvents),
    compensationChanges: sequenceChangeCount(before.compensationEvents, after.compensationEvents),
    coolantChanges: sequenceChangeCount(before.coolantEvents, after.coolantEvents),
    retractChanges: sequenceChangeCount(before.retractEvents, after.retractEvents),
    unitModeChanged: before.units !== after.units,
    positioningModeChanged: before.absoluteMode !== after.absoluteMode,
    planeChanged: before.plane !== after.plane,
    cannedCycleChanged: before.cannedCycle !== after.cannedCycle
  };
}

/**
 * Sequence diff of NC files with a modal/semantic summary. `displayLimit`
 * bounds only the returned change list; counts and truncation are computed
 * from the complete replacement-aware change set.
 */
export function compareNc(left: string, right: string, displayLimit = 200): NcDiffResult {
  const safeLimit = Math.max(0, Math.floor(displayLimit));
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

  const allChanges = pairNcChanges(rawChanges);
  const displayed = allChanges.slice(0, safeLimit);
  const modified = allChanges.filter(change => change.kind === "modified").length;
  const beforeSummary = summarizeNc(left);
  const afterSummary = summarizeNc(right);
  const toolsBeforeArr = [...new Set(beforeSummary.toolChanges)].sort((x, y) => x - y);
  const toolsAfterArr = [...new Set(afterSummary.toolChanges)].sort((x, y) => x - y);

  return {
    equal: allChanges.length === 0,
    totalChangeCount: allChanges.length,
    totalChanges: allChanges.length,
    displayedChangeCount: displayed.length,
    displayedChanges: displayed.length,
    truncated: allChanges.length > safeLimit,
    addedLines: added,
    removedLines: removed,
    modifiedLines: modified,
    toolsBefore: toolsBeforeArr,
    toolsAfter: toolsAfterArr,
    changes: displayed,
    semantic: { before: beforeSummary, after: afterSummary },
    semanticSummary: semanticDifference(beforeSummary, afterSummary)
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
