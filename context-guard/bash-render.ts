import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration } from "../common/duration.js";

/**
 * Max logical lines of the bash command shown in renderCall, collapsed.
 * Same default as pi-agent-run pwsh/py. Longer scripts get `… +N lines`;
 * Ctrl+O (expanded) lifts the cap and shows the command whole, the way the
 * inherited native build of this row always did — the cap must never be the
 * only view of a command.
 * Width is left to pi-tui Text wrap — no hard char truncate, so long
 * one-liners stay fully readable (the main pain of the old single-line preview).
 */
export const PREVIEW_LINES = 8;

function highlightBash(command: string, theme: Theme): string[] {
  if (!command) {
    return [theme.fg("toolOutput", "...")];
  }

  // Pi's built-in highlighter (cli-highlight / hljs bash). Same path as
  // pi-agent-run's python branch — no cross-extension import, no local grammar.
  try {
    const lines = highlightCode(command, "bash");
    return lines.length > 0 ? lines : [theme.fg("toolOutput", "...")];
  } catch {
    return command.split("\n").map((line) => theme.fg("toolOutput", line));
  }
}

export function formatBashBody(
  command: string,
  theme: Theme,
  previewLines: number = PREVIEW_LINES,
): string[] {
  const lines = highlightBash(command, theme);
  const limit = Math.max(1, previewLines);

  if (lines.length <= limit) {
    return lines;
  }

  const more = lines.length - limit;
  const suffix = theme.fg("muted", `… +${more} line${more === 1 ? "" : "s"}`);
  return [...lines.slice(0, limit), suffix];
}

/**
 * Header line `$ (timeout 5m) 12m 03s` + multi-line command body.
 * Mirrors pi-agent-run formatCodeCall layout for pwsh/py.
 */
export function formatBashCall(
  command: string | undefined,
  timeout: number | undefined,
  theme: Theme,
  elapsedMs?: number,
  previewLines: number = PREVIEW_LINES,
): string {
  const prefix = theme.fg("toolTitle", theme.bold("$"));
  const timeoutSuffix = timeout
    ? theme.fg("muted", ` (timeout ${formatDuration(timeout * 1000)})`)
    : "";
  const timerSuffix =
    elapsedMs !== undefined ? theme.fg("muted", ` ${formatDuration(elapsedMs)}`) : "";
  const body = formatBashBody(command ?? "", theme, previewLines);
  return `${prefix}${timeoutSuffix}${timerSuffix}\n${body.join("\n")}`;
}

const TIMER_UPDATE_INTERVAL_MS = 1_000;
const TIMER_VISIBLE_THRESHOLD_MS = 5_000;

function visibleElapsedMs(
  startTime: number | undefined,
  opts: { running: boolean; now?: number } = { running: true },
): number | undefined {
  if (!opts.running || startTime === undefined) return undefined;
  const elapsed = (opts.now ?? Date.now()) - startTime;
  if (elapsed < TIMER_VISIBLE_THRESHOLD_MS) return undefined;
  return elapsed;
}

export interface BashTimerState {
  /** When the command started running. */
  startedAt?: number;
  /** When the row settled — frozen, so the header keeps the duration after the run. */
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

/**
 * Live 1 Hz clock while the command runs, frozen value after it settles.
 *
 * The value must survive the settle: Pi's own bash row prints `Took 2m 12s` when the result arrives,
 * but that line is drawn by the *built-in* `renderResult` and is fed by the built-in `renderCall` —
 * which this override replaces (`context.state.startedAt`), so a stock Pi row would show the duration
 * while this one showed none at all: 1 800 of 12 151 bash rows over 3 weeks ran ≥ 5 s, 2.9% ≥ 30 s
 * (verified by rendering the real renderers with and without the seeding, 2026-10-05).
 * The duration therefore lives in the header, before and after, and never moves: the same threshold
 * decides visibility in both states, so a 0.4 s command stays as plain as it is today.
 *
 * State lives in `context.state` under its own key — one object per row, shared with the inherited
 * native result renderer, which reads `startedAt`/`endedAt`/`interval` and would print a second,
 * duplicate duration if these lived at the top level.
 */
export function syncBashTimer(
  state: BashTimerState,
  opts: { executionStarted: boolean; isPartial: boolean; invalidate: () => void; now?: number },
): number | undefined {
  if (opts.executionStarted && opts.isPartial) {
    const now = opts.now ?? Date.now();
    if (state.startedAt === undefined) {
      state.startedAt = now;
    }
    if (state.interval === undefined) {
      state.interval = setInterval(() => {
        opts.invalidate();
      }, TIMER_UPDATE_INTERVAL_MS);
    }
    return visibleElapsedMs(state.startedAt, { running: true, now });
  }

  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  if (state.startedAt === undefined) return undefined; // never ran (denied, aborted before start)

  state.endedAt ??= opts.now ?? Date.now();
  const elapsed = state.endedAt - state.startedAt;
  return elapsed >= TIMER_VISIBLE_THRESHOLD_MS ? elapsed : undefined;
}

export function createBashCallComponent(
  args: { command?: string; timeout?: number },
  theme: Theme,
  context: {
    toolCallId: string;
    /** One object per tool row, shared with the inherited native result renderer (see syncBashTimer). */
    state: { bashTimer?: BashTimerState };
    expanded: boolean;
    executionStarted: boolean;
    isPartial: boolean;
    invalidate: () => void;
    lastComponent?: unknown;
  },
): Text {
  const timer = (context.state.bashTimer ??= {});
  const elapsedMs = syncBashTimer(timer, {
    executionStarted: context.executionStarted,
    isPartial: context.isPartial,
    invalidate: context.invalidate,
  });

  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  // Ctrl+O is the escape hatch for a long command: the cap exists for the collapsed row only.
  text.setText(
    formatBashCall(
      args.command,
      args.timeout,
      theme,
      elapsedMs,
      context.expanded ? Number.POSITIVE_INFINITY : PREVIEW_LINES,
    ),
  );
  return text;
}
