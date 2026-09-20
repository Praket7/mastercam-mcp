import { z } from "zod";

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
  value: z.number().finite().positive().max(1_000_000),
  unit: FeedUnitSchema
}).strict();
export type FeedRate = z.infer<typeof FeedRateSchema>;

export const SpindleSpeedSchema = z.object({
  value: z.number().finite().positive().max(1_000_000),
  unit: SpindleUnitSchema
}).strict();
export type SpindleSpeed = z.infer<typeof SpindleSpeedSchema>;

export const LengthSchema = z.object({
  value: z.number().finite(),
  unit: LengthUnitSchema
}).strict();
export type Length = z.infer<typeof LengthSchema>;

export const MM_PER_INCH = 25.4;
const LINEAR_FEED_UNITS: ReadonlySet<FeedUnit> = new Set(["mm/min", "in/min"]);

/** Millimeters-per-minute equivalent, used only for comparisons and limits. */
export function feedToMmPerMinute(feed: FeedRate): number {
  const perRev = !LINEAR_FEED_UNITS.has(feed.unit);
  const mm = feed.unit.startsWith("mm") ? 1 : MM_PER_INCH;
  return perRev ? feed.value * mm : feed.value * mm;
}

export function sameFeed(a: FeedRate, b: FeedRate): boolean {
  return feedToMmPerMinute(a) === feedToMmPerMinute(b);
}

/** Human formatting that always shows the unit, e.g. "1800 mm/min". */
export function formatFeed(feed: FeedRate): string {
  return `${feed.value} ${feed.unit}`;
}

export function formatSpindle(speed: SpindleSpeed): string {
  return `${speed.value} ${speed.unit}`;
}
