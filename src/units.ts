// Units - dimensional correctness for feed/spindle
// Never silently convert per-rev to per-minute without RPM

export const MM_PER_INCH = 25.4;

export const LINEAR_FEED_UNITS = new Set(["mm/min", "in/min"] as const);
export const PER_REV_UNITS = new Set(["mm/rev", "in/rev"] as const);
export const ALL_FEED_UNITS = new Set(["mm/min", "in/min", "mm/rev", "in/rev"] as const);

export type FeedUnit = "mm/min" | "in/min" | "mm/rev" | "in/rev";
export type SpindleUnit = "rpm";

export interface FeedRate {
  value: number;
  unit: FeedUnit;
}
export interface SpindleSpeed {
  value: number;
  unit: SpindleUnit;
}

// Dimensionally correct: per-rev feeds cannot be converted to per-minute without spindle speed
// This function intentionally does NOT allow silent conversion
export function feedToMmPerMinute(feed: FeedRate, spindleRpm?: number): number | null {
  if (LINEAR_FEED_UNITS.has(feed.unit as any)) {
    const mm = feed.unit.startsWith("mm") ? 1 : MM_PER_INCH;
    return feed.value * mm;
  }
  if (PER_REV_UNITS.has(feed.unit as any)) {
    if (spindleRpm === undefined || !Number.isFinite(spindleRpm) || spindleRpm <= 0) {
      return null; // cannot convert without RPM - dimensionally invalid
    }
    const mm = feed.unit.startsWith("mm") ? 1 : MM_PER_INCH;
    return feed.value * mm * spindleRpm;
  }
  return null;
}

export function sameFeed(a: FeedRate, b: FeedRate): boolean {
  // Strict equality: same value AND same unit. No silent conversion.
  // If caller wants to compare across units, they must explicitly provide RPM and use feedToMmPerMinute
  return a.value === b.value && a.unit === b.unit;
}

export function normalizeFeedForComparison(a: FeedRate, b: FeedRate, spindleRpm?: number): { equal: boolean; reason?: string } {
  if (a.unit === b.unit) return { equal: a.value === b.value };
  // Different units - only comparable if both are linear, or both are per-rev with RPM
  if (LINEAR_FEED_UNITS.has(a.unit as any) && LINEAR_FEED_UNITS.has(b.unit as any)) {
    const aMm = feedToMmPerMinute(a);
    const bMm = feedToMmPerMinute(b);
    if (aMm !== null && bMm !== null) return { equal: aMm === bMm };
  }
  if (PER_REV_UNITS.has(a.unit as any) && PER_REV_UNITS.has(b.unit as any) && spindleRpm !== undefined) {
    const aMm = feedToMmPerMinute(a, spindleRpm);
    const bMm = feedToMmPerMinute(b, spindleRpm);
    if (aMm !== null && bMm !== null) return { equal: aMm === bMm };
  }
  return { equal: false, reason: `Cannot compare ${a.unit} vs ${b.unit} without explicit conversion` };
}
