import * as z from "zod/v4";

/**
 * Explicit quantity model per audit SAFE-01: numbers are meaningless without
 * units in manufacturing data. A bare `feed: 100` could be mm/min, in/min or
 * mm/rev, so every quantity carries its unit explicitly.
 */
export const FeedUnitSchema = z.enum(["mm/min", "in/min", "mm/rev", "in/rev"]);
export type FeedUnit = z.infer<typeof FeedUnitSchema>;

export const SpindleUnitSchema = z.enum(["rpm"]);
export type SpindleUnit = z.infer<typeof SpindleUnitSchema>;

export const LengthUnitSchema = z.enum(["mm", "in"]);
export type LengthUnit = z.infer<typeof LengthUnitSchema>;

export const FeedRateSchema = z.object({
  value: z.number().finite().positive().max(1_000_000).describe("Positive feed magnitude. Interpret it using the explicit unit in this object."),
  unit: FeedUnitSchema.describe("Feed unit: linear distance per minute or distance per spindle revolution.")
}).strict();
export type FeedRate = z.infer<typeof FeedRateSchema>;

export const SpindleSpeedSchema = z.object({
  value: z.number().finite().positive().max(1_000_000).describe("Positive spindle speed magnitude in the explicit unit in this object."),
  unit: SpindleUnitSchema.describe("Spindle speed unit. Currently only revolutions per minute is accepted.")
}).strict();
export type SpindleSpeed = z.infer<typeof SpindleSpeedSchema>;

export const LengthSchema = z.object({
  value: z.number().finite().describe("Length value interpreted using the explicit unit in this object."),
  unit: LengthUnitSchema.describe("Length unit used by the associated measurement.")
}).strict();
export type Length = z.infer<typeof LengthSchema>;

export const MM_PER_INCH = 25.4;
export const LINEAR_FEED_UNITS: ReadonlySet<FeedUnit> = new Set(["mm/min", "in/min"]);
export const PER_REV_UNITS: ReadonlySet<FeedUnit> = new Set(["mm/rev", "in/rev"]);
export const ALL_FEED_UNITS: ReadonlySet<FeedUnit> = new Set(["mm/min", "in/min", "mm/rev", "in/rev"]);

/** Millimeters-per-minute equivalent. Returns null for per-rev without RPM (dimensionally invalid). */
export function feedToMmPerMinute(feed: FeedRate, spindleRpm?: number): number | null {
  if (LINEAR_FEED_UNITS.has(feed.unit)) {
    const mm = feed.unit.startsWith("mm") ? 1 : MM_PER_INCH;
    return feed.value * mm;
  }
  if (PER_REV_UNITS.has(feed.unit)) {
    if (spindleRpm === undefined || !Number.isFinite(spindleRpm) || spindleRpm <= 0) {
      return null;
    }
    const mm = feed.unit.startsWith("mm") ? 1 : MM_PER_INCH;
    return feed.value * mm * spindleRpm;
  }
  return null;
}

export function sameFeed(a: FeedRate, b: FeedRate): boolean {
  return a.value === b.value && a.unit === b.unit;
}

export function normalizeFeedForComparison(a: FeedRate, b: FeedRate, spindleRpm?: number): { equal: boolean; reason?: string } {
  if (a.unit === b.unit) return { equal: a.value === b.value };
  if (LINEAR_FEED_UNITS.has(a.unit) && LINEAR_FEED_UNITS.has(b.unit)) {
    const aMm = feedToMmPerMinute(a);
    const bMm = feedToMmPerMinute(b);
    if (aMm !== null && bMm !== null) return { equal: aMm === bMm };
  }
  if (PER_REV_UNITS.has(a.unit) && PER_REV_UNITS.has(b.unit) && spindleRpm !== undefined) {
    const aMm = feedToMmPerMinute(a, spindleRpm);
    const bMm = feedToMmPerMinute(b, spindleRpm);
    if (aMm !== null && bMm !== null) return { equal: aMm === bMm };
  }
  return { equal: false, reason: `Cannot compare ${a.unit} vs ${b.unit} without explicit conversion` };
}

/** Human formatting that always shows the unit, e.g. "1800 mm/min". */
export function formatFeed(feed: FeedRate): string {
  return `${feed.value} ${feed.unit}`;
}

export function formatSpindle(speed: SpindleSpeed): string {
  return `${speed.value} ${speed.unit}`;
}
