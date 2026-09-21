import { createHash } from "node:crypto";

export type SetupInput = { part?: Record<string, unknown>; machine?: Record<string, unknown>; stock?: Record<string, unknown>; wcs?: Record<string, unknown>; operations?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>; notes?: string[] };

export function setupSheet(input: SetupInput) {
  const operations = input.operations ?? [];
  const tools = input.tools ?? [];
  return { schema: "mastercam-mcp/setup-sheet/v1", generatedAt: new Date().toISOString(), part: input.part ?? {}, machine: input.machine ?? {}, stock: input.stock ?? {}, wcs: input.wcs ?? {}, tools, operations, notes: input.notes ?? [], review: { status: "draft", requiresApproval: true }, safety: "This document is evidence for review and does not prove machine safety" };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}

export function compareJson(left: unknown, right: unknown) {
  const leftCanonical = canonicalJson(left);
  const rightCanonical = canonicalJson(right);
  const leftHash = createHash("sha256").update(leftCanonical).digest("hex");
  const rightHash = createHash("sha256").update(rightCanonical).digest("hex");

  if (leftHash === rightHash) return { equal: true, added: [], removed: [], modified: [], unchanged: Object.keys(left as object ?? {}), leftHash, rightHash };

  const leftObj = left as Record<string, unknown>;
  const rightObj = right as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(leftObj), ...Object.keys(rightObj)]);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: Array<{ key: string; left: unknown; right: unknown }> = [];
  const unchanged: string[] = [];

  for (const key of allKeys) {
    const inLeft = key in leftObj;
    const inRight = key in rightObj;
    if (!inLeft) added.push(key);
    else if (!inRight) removed.push(key);
    else if (canonicalJson(leftObj[key]) === canonicalJson(rightObj[key])) unchanged.push(key);
    else modified.push({ key, left: leftObj[key], right: rightObj[key] });
  }

  return { equal: false, added, removed, modified, unchanged, leftHash, rightHash };
}

function myersDiff<T>(a: T[], b: T[], equals: (x: T, y: T) => boolean): Array<{ type: "added" | "removed" | "unchanged"; value: T; indexA?: number; indexB?: number }> {
  const n = a.length;
  const m = b.length;
  const maxD = n + m;
  const v: number[] = new Array(2 * maxD + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= maxD; d++) {
    const vd = v;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vd[k - 1 + maxD]! < vd[k + 1 + maxD]!)) {
        x = vd[k + 1 + maxD]!;
      } else {
        x = vd[k - 1 + maxD]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && equals(a[x]!, b[y]!)) {
        x++;
        y++;
      }
      vd[k + maxD] = x;
      if (x >= n && y >= m) {
        const path: Array<{ type: "added" | "removed" | "unchanged"; value: T; indexA?: number; indexB?: number }> = [];
        let cx = n, cy = m;
        for (let dd = d; dd >= 0; dd--) {
          const vdd = trace[dd]!;
          const kk = cx - cy;
          let prevX: number, prevY: number;
          if (kk === -dd || (kk !== dd && vdd[kk - 1 + maxD]! < vdd[kk + 1 + maxD]!)) {
            prevX = vdd[kk + 1 + maxD]!;
            prevY = prevX - kk;
          } else {
            prevX = vdd[kk - 1 + maxD]! + 1;
            prevY = prevX - kk;
          }
          while (cx > prevX || cy > prevY) {
            if (cx > prevX && cy > prevY) {
              path.unshift({ type: "unchanged", value: a[cx - 1]!, indexA: cx - 1, indexB: cy - 1 });
              cx--; cy--;
            } else if (cx > prevX) {
              path.unshift({ type: "removed", value: a[cx - 1]!, indexA: cx - 1 });
              cx--;
            } else {
              path.unshift({ type: "added", value: b[cy - 1]!, indexB: cy - 1 });
              cy--;
            }
          }
        }
        return path;
      }
    }
    trace.push([...vd]);
  }
  return [];
}

export function compareNc(left: string, right: string) {
  const a = left.split(/\r?\n/).filter(Boolean);
  const b = right.split(/\r?\n/).filter(Boolean);

  const path = myersDiff(a, b, (x, y) => x === y);

  const changes: Array<{ line: number; type: "added" | "removed" | "modified"; before?: string; after?: string; category?: string }> = [];
  let lineA = 0, lineB = 0;

  for (const step of path) {
    if (step.type === "unchanged") {
      lineA++; lineB++;
    } else if (step.type === "removed") {
      changes.push({ line: lineA + 1, type: "removed", before: step.value, category: categorizeNcLine(step.value) });
      lineA++;
    } else if (step.type === "added") {
      changes.push({ line: lineB + 1, type: "added", after: step.value, category: categorizeNcLine(step.value) });
      lineB++;
    }
  }

  const totalChanges = changes.length;
  const displayedChanges = Math.min(totalChanges, 200);
  const truncated = totalChanges > 200;

  const tools = (text: string) => [...new Set([...text.matchAll(/\bT(\d+)\b/gi)].map(match => Number(match[1])))].sort((x, y) => x - y);

  const semanticSummary = {
    toolChanges: changes.filter(c => c.category === "tool_change").length,
    feedChanges: changes.filter(c => c.category === "feed").length,
    spindleChanges: changes.filter(c => c.category === "spindle").length,
    rapidMoves: changes.filter(c => c.category === "rapid").length,
    workOffsetChanges: changes.filter(c => c.category === "work_offset").length,
    compensationChanges: changes.filter(c => c.category === "compensation").length,
    coolantChanges: changes.filter(c => c.category === "coolant").length
  };

  return {
    equal: totalChanges === 0 && a.length === b.length,
    totalChanges,
    displayedChanges,
    truncated,
    toolsBefore: tools(left),
    toolsAfter: tools(right),
    changes: changes.slice(0, 200),
    semanticSummary
  };
}

function categorizeNcLine(line: string): string {
  const upper = line.toUpperCase().trim();
  if (/^T\d+/i.test(upper)) return "tool_change";
  if (/^G(?:0|00)/.test(upper)) return "rapid";
  if (/^G(?:1|01)/.test(upper)) return "feed";
  if (/^S\d+/i.test(upper)) return "spindle";
  if (/^F\d+/i.test(upper)) return "feed";
  if (/G(?:5[4-9]|5[0-9]\.[0-9])/.test(upper)) return "work_offset";
  if (/G(?:4[0-9]|4[0-9]\.[0-9])/.test(upper)) return "compensation";
  if (/M(?:[3-5]|0[3-5]|0[7-9]|[7-9])/.test(upper)) return "coolant";
  if (/G(?:8[0-9]|8[0-9]\.[0-9])/.test(upper)) return "canned_cycle";
  if (/G(?:1[7-9]|1[7-9]\.[0-9])/.test(upper)) return "plane";
  if (/[ABC]\s*[+-]?\d+/.test(upper)) return "rotary";
  if (/M(?:[02]|0[02]|30)/.test(upper)) return "stop";
  return "other";
}

export const MachineProfileSchema = {
  controller: { type: "string", minLength: 1 },
  maxFeed: { type: "number", positive: true, optional: true },
  maxFeedUnit: { type: "enum", values: ["mm/min", "in/min"], optional: true },
  maxSpindleSpeed: { type: "number", positive: true, optional: true },
  holderFamily: { type: "string", optional: true },
  axisTravels: { type: "object", properties: { x: { type: "number", positive: true, optional: true }, y: { type: "number", positive: true, optional: true }, z: { type: "number", positive: true, optional: true } }, optional: true },
  rotaryLimits: { type: "object", properties: { a: { type: "tuple", items: [{ type: "number" }, { type: "number" }], optional: true }, b: { type: "tuple", items: [{ type: "number" }, { type: "number" }], optional: true }, c: { type: "tuple", items: [{ type: "number" }, { type: "number" }], optional: true } }, optional: true },
  maxToolLength: { type: "number", positive: true, optional: true },
  toolNumberRange: { type: "tuple", items: [{ type: "integer", positive: true }, { type: "integer", positive: true }], optional: true },
  supportedFeedModes: { type: "array", items: { type: "enum", values: ["mm/min", "in/min", "mm/rev", "in/rev"] }, optional: true },
  coolantCapabilities: { type: "array", items: { type: "string" }, optional: true }
};

export function validateMachine(operation: Record<string, unknown>, profile: Record<string, unknown>) {
  const issues: Array<{ code: string; severity: "warning" | "error"; message: string }> = [];
  const feed = Number((operation["feed"] as number) ?? (operation["feedRate"] as { value: number })?.value);
  const maxFeed = Number(profile["maxFeed"]);
  const speed = Number((operation["speed"] as number) ?? (operation["spindleSpeed"] as { value: number })?.value);
  const maxSpeed = Number(profile["maxSpindleSpeed"]);

  if (Number.isFinite(maxFeed) && Number.isFinite(feed) && feed > maxFeed) issues.push({ code: "FEED_EXCEEDS_MACHINE_LIMIT", severity: "error", message: "Operation feed exceeds the selected machine limit" });
  if (Number.isFinite(maxSpeed) && Number.isFinite(speed) && speed > maxSpeed) issues.push({ code: "SPEED_EXCEEDS_MACHINE_LIMIT", severity: "error", message: "Spindle speed exceeds the selected machine limit" });
  if (!profile["controller"]) issues.push({ code: "CONTROLLER_UNKNOWN", severity: "warning", message: "Controller is not defined so NC behavior is not fully verifiable" });
  if (!profile["holderFamily"]) issues.push({ code: "HOLDER_PROFILE_MISSING", severity: "warning", message: "Holder family is not defined so holder clearance is not verifiable" });

  return { valid: !issues.some(issue => issue.severity === "error"), verification: issues.length ? "review_required" : "fixture_only", issues };
}

export function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }