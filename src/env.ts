/** Parse standard boolean environment values consistently without importing runtime configuration. */
export function parseBooleanEnvironmentVariable(value: string | undefined, defaultValue: boolean, setting: string): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false" || normalized === "") return false;
  throw new Error(`Invalid ${setting}: ${JSON.stringify(value)}. Use true, false, 1, or 0.`);
}
