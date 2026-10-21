// Shared helpers for sub-agents. Keep this file dependency-free so it can be
// imported by any module without risking circular imports.

/** Parse a positive finite integer. Returns undefined for missing/invalid values. */
export function parsePositiveInt(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/**
 * Parse a finite integer >= 0. Returns undefined for missing/invalid values.
 * Used where 0 is a meaningful "off" rather than an absent value.
 */
export function parseNonNegativeInt(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}
