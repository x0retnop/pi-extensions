/**
 * Human durations for TUI output — one format for every duration the user reads:
 * `45s` / `1m 30s` / `5m` / `1h 05m` / `2h 00m`.
 *
 * Empty lower units are dropped (`5m`, not `5m 00s`), the rest are zero-padded
 * (`12m 03s`, not `12m 3s`) so a 1 Hz ticking timer keeps its column width.
 *
 * Tool `timeout` **parameters** stay in seconds (agent-facing — agents write
 * seconds, and the schemas say so); only the display goes through here:
 * `formatDuration(timeout * 1000)`. The runtime half of the same format is host
 * patch P-10 (`scripts/pi_runtime_patches.py`): it installs this algorithm into
 * Pi's own `formatDuration`, which drives the native shell renderers' timeout
 * suffix, their `Took …` line, and `Command timed out after …`.
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < 1000) return safe < 50 ? "0s" : `${(safe / 1000).toFixed(1)}s`;

  const totalSeconds = Math.floor(safe / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (n: number) => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m${seconds > 0 ? ` ${pad(seconds)}s` : ""}`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds > 0 ? ` ${pad(seconds)}s` : ""}`;
  }
  return `${seconds}s`;
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * Inverse of `formatDuration` for hand-typed input: `60000` (a bare number is
 * ms), `90s`, `10m`, `1h 30m`, `1.5m`. Returns undefined for anything that does
 * not resolve to a positive duration — callers read that as "not set".
 */
export function parseDuration(text: string | undefined): number | undefined {
  const cleaned = (text ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!cleaned) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
    const ms = Number(cleaned);
    return ms > 0 ? Math.round(ms) : undefined;
  }

  const parts = [...cleaned.matchAll(/(\d+(?:\.\d+)?)([hms])/g)];
  // Every character must be consumed, so `10x` or `1m5` is a typo, not a guess.
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== cleaned) {
    return undefined;
  }
  const ms = parts.reduce(
    (sum, [, value, unit]) => sum + Number(value) * UNIT_MS[unit],
    0,
  );
  return ms > 0 ? Math.round(ms) : undefined;
}
