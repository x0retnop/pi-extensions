/**
 * Shared status-bar helpers for Pi extensions.
 *
 * Pi renders individual `ctx.ui.setStatus(key, text)` entries in key order
 * with a space between them. To get readable separators, each visible block
 * ends with ` |` and the timer block uses a key (`_`) that sorts before the
 * other status keys so it appears first:
 *
 *   11:11 · 11:11 | gate:YOLO | pm:pi-project-memory | curate:auto | web:on | role:kimi
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export function formatDurationHMS(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / MS_PER_SECOND));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const mm = minutes.toString().padStart(2, "0");
  const ss = seconds.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

export interface TimerStatusParts {
  totalMs: number;
  lastMs?: number;
}

export function formatTimerStatus(parts: TimerStatusParts): string | undefined {
  const total = formatDurationHMS(parts.totalMs);
  const last = parts.lastMs !== undefined ? formatDurationHMS(parts.lastMs) : undefined;
  if (last === undefined) {
    return total;
  }
  return `${total} · ${last}`;
}

/**
 * Wrapper around `ctx.ui.setStatus` that:
 * - checks `hasUI` and that `setStatus` exists
 * - appends ` |` to non-empty values so blocks are visually separated
 * - passes `undefined` through unchanged (hides the block)
 */
export function setStatusBlock(ctx: any, key: string, value: string | undefined): void {
  if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") return;
  const text = value !== undefined && value.length > 0 ? `${value} |` : undefined;
  try {
    ctx.ui.setStatus(key, text);
  } catch {
    // ignore
  }
}
