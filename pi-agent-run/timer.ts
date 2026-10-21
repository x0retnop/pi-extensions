/**
 * Live elapsed timer for the `pwsh` / `py` rows (1 Hz after the visibility threshold).
 *
 * The state lives in the row's own `context.state` — one object per tool row, handed to every render
 * of that row — not in a module map keyed by `toolCallId`. The old map had to be cleaned up in
 * `execute`'s `finally`, which deleted the only copy of `startTime` exactly when the result arrived,
 * so the settled row lost the duration it had been showing while the command ran (the same failure
 * `context-guard/bash-render.ts` fixed for the bash row). Keeping the value on the row removes the
 * lifecycle entirely: nothing to start, nothing to clean up, nothing to leak.
 */

export const TIMER_VISIBLE_THRESHOLD_MS = 5_000;
export const TIMER_UPDATE_INTERVAL_MS = 1_000;

export interface RunTimerState {
  /** When the command started running. */
  startedAt?: number;
  /** When the row settled — frozen, so the header keeps the duration after the run. */
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

/** Visible elapsed ms while running, or undefined if still under the delay threshold. */
export function visibleElapsedMs(
  startTime: number | undefined,
  opts: { running: boolean; now?: number } = { running: true },
): number | undefined {
  if (!opts.running || startTime === undefined) return undefined;
  const elapsed = (opts.now ?? Date.now()) - startTime;
  if (elapsed < TIMER_VISIBLE_THRESHOLD_MS) return undefined;
  return elapsed;
}

/**
 * Drive the row clock: returns the elapsed ms to print, or undefined when there is nothing to show.
 *
 * Running: starts the clock on the first render after execution begins and ticks 1 Hz until the
 * value is visible (the tick fires from `threshold - interval` on, so the first show is prompt
 * without repainting an invisible row every second from zero).
 * Settled: freezes at the value the run ended with and keeps it for every later render — the header
 * reads the same before and after the result, and a command under the threshold stays clean.
 */
export function syncRunTimer(
  state: RunTimerState,
  opts: { executionStarted: boolean; isPartial: boolean; invalidate: () => void; now?: number },
): number | undefined {
  if (opts.executionStarted && opts.isPartial) {
    const now = opts.now ?? Date.now();
    state.startedAt ??= now;
    if (state.interval === undefined) {
      state.interval = setInterval(() => {
        const elapsed = state.startedAt === undefined ? 0 : Date.now() - state.startedAt;
        if (
          elapsed >= TIMER_VISIBLE_THRESHOLD_MS ||
          elapsed + TIMER_UPDATE_INTERVAL_MS >= TIMER_VISIBLE_THRESHOLD_MS
        ) {
          opts.invalidate();
        }
      }, TIMER_UPDATE_INTERVAL_MS);
    }
    return visibleElapsedMs(state.startedAt, { running: true, now });
  }

  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  if (state.startedAt === undefined) return undefined; // never ran (denied, or aborted before start)

  state.endedAt ??= opts.now ?? Date.now();
  const elapsed = state.endedAt - state.startedAt;
  return elapsed >= TIMER_VISIBLE_THRESHOLD_MS ? elapsed : undefined;
}
