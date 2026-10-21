/**
 * Presentation for the `write` override.
 *
 * The row is a liveness and scale signal, not a viewer: exactly one line, always.
 * While the arguments stream: `write <path> +1.8k · 4s` — the size hint grows and the
 * timer proves the stream is alive even when the path has not arrived yet (Moonshot /
 * DeepSeek emit `content` before `path`, so the header stays path-less for most of the
 * generation). Once written: `write <path> 1.1k → 2.4k, 96 lines`.
 *
 * No content preview and no diff on purpose: the built-in renderer's 10-line preview
 * caps out mid-stream (the row stops changing) and an expanded diff is the Ctrl+O
 * flash bomb (docs/burned.md). Read the file when you want to see it.
 *
 * Size hint format mirrors `pi-multi-edit/render.ts` (`+1.8k`) — same visual language,
 * duplicated here rather than imported across extensions.
 */
import { Container, Text } from "@earendil-works/pi-tui";
import { formatDuration } from "../common/duration.js";

export interface WriteRowState {
  /** When the row first rendered; the timer runs while the tool call is incomplete. */
  startedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  /** Size of the file before this write (null = did not exist). Captured once, at argsComplete. */
  oldBytes?: number | null;
  oldChecked?: boolean;
}

export interface WriteHeaderInfo {
  /** ms since the row appeared; undefined once the row is settled. */
  elapsedMs?: number;
  /** Pre-write file size in bytes; null when the file did not exist. */
  oldBytes?: number | null;
  /** Whether the tool call arguments have fully arrived. */
  argsComplete?: boolean;
  /** Whether the tool result is final. */
  settled?: boolean;
  /** Target path resolved outside the args (executed call / content match). */
  path?: string;
}

export function pathOf(args: Record<string, unknown> | undefined): string | undefined {
  const raw = args?.path ?? args?.file_path;
  return typeof raw === "string" && raw ? raw : undefined;
}

export function contentOf(args: Record<string, unknown> | undefined): string {
  const raw = args?.content;
  return typeof raw === "string" ? raw : "";
}

/**
 * Last resort for a row whose streamed args never carried `path`: match it against writes that
 * already executed, by content prefix. The row's content is a prefix of (or equal to) the final
 * content, so a prefix match identifies the call even when the row's tool-call id is stale.
 * Entries are searched newest-first; identical-content writes resolve to the same path anyway.
 */
export function matchRecentPath(
  recent: ReadonlyArray<{ path: string; content: string }>,
  content: string,
): string | undefined {
  if (!content) return undefined;
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    if (entry.content.startsWith(content)) return entry.path;
  }
  return undefined;
}

export function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

/** Characters and lines of the content seen so far (trailing newline is not a line). */
export function contentStats(args: Record<string, unknown> | undefined): { chars: number; lines: number } {
  const content = contentOf(args);
  if (!content) return { chars: 0, lines: 0 };
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return { chars: content.length, lines: body ? body.split("\n").length : 0 };
}

/** `999` / `1.8k` — same rounding as pi-multi-edit's stream hint. */
export function fmtSize(n: number): string {
  if (n < 1000) return String(n);
  const tenths = Math.round(n / 100) / 10;
  return `${tenths}k`;
}

/**
 * One-line header. Streaming: `write <path> +1.8k · 4s`. Settled: `write <path> 2.4k, 96 lines`,
 * with the pre-write size in front when the file was overwritten.
 */
export function formatWriteHeader(
  args: Record<string, unknown> | undefined,
  theme: any,
  info: WriteHeaderInfo = {},
): string {
  const path = info.path ?? pathOf(args);
  const target = path ? theme.fg("accent", shortenPath(path)) : theme.fg("muted", "...");
  const { chars, lines } = contentStats(args);
  const settled = info.settled === true;

  let stats = "";
  if (settled) {
    if (chars > 0) {
      const size = `${fmtSize(chars)}, ${lines} line${lines === 1 ? "" : "s"}`;
      stats = info.oldBytes != null
        ? theme.fg("dim", `${fmtSize(info.oldBytes)} → ${size}`)
        : theme.fg("dim", size);
    } else if (info.oldBytes != null && info.oldBytes > 0) {
      stats = theme.fg("dim", `${fmtSize(info.oldBytes)} → empty`);
    }
  } else if (chars > 0) {
    // Same counts as the settled line, so the row reads the same before and after — only the
    // target is missing while the model has not emitted `path` yet (it writes `content` first).
    stats = theme.fg("dim", `+${fmtSize(chars)}, ${lines} line${lines === 1 ? "" : "s"}`);
  }

  const timer = info.elapsedMs !== undefined ? theme.fg("muted", `· ${formatDuration(info.elapsedMs)}`) : "";

  return [
    theme.fg("toolTitle", theme.bold("write")),
    target,
    stats,
    timer,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Model-facing result line — the only channel the agent has after a write. Pi's native line
 * (`Successfully wrote to <path>`) carries no facts, so the model cannot tell a 12 KB file from a
 * truncated one, nor a fresh file from an overwrite, without a follow-up read (measured: it does
 * that in 2.2% of calls). Same numbers as the row, so both agree.
 */
export function formatWriteResult(
  path: string,
  content: string,
  oldBytes: number | null,
): string {
  const { chars, lines } = contentStats({ content });
  const size = `${fmtSize(chars)} chars, ${lines} line${lines === 1 ? "" : "s"}`;
  const origin = oldBytes === null ? "new file" : `overwrote ${fmtSize(oldBytes)}`;
  return `Wrote ${path} — ${size} (${origin})`;
}

const TICK_MS = 1_000;

/**
 * 1 Hz repaint while the row is incomplete — the only sign of life when the provider has not
 * sent the arguments yet. Unlike the bash timer there is no visible threshold: a path-less
 * `write ...` with a moving clock is the whole point.
 */
export function syncWriteTimer(
  state: WriteRowState,
  opts: { running: boolean; invalidate: () => void; now?: number },
): number | undefined {
  if (opts.running) {
    const now = opts.now ?? Date.now();
    if (state.startedAt === undefined) state.startedAt = now;
    if (state.interval === undefined) {
      state.interval = setInterval(() => opts.invalidate(), TICK_MS);
    }
    return Math.max(0, now - state.startedAt);
  }
  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  return undefined;
}

/** Call slot component: one Text line, reused across renders so the row never jumps. */
export function writeCallComponent(text: string, context: { lastComponent?: unknown }): Text {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(text);
  return component;
}

/** Result slot: error text only. Success adds nothing — the header already carries the numbers. */
export function writeResultComponent(
  output: string | undefined,
  theme: any,
  context: { lastComponent?: unknown },
): Container {
  const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
  component.clear();
  if (output) component.addChild(new Text(theme.fg("error", output), 1, 0));
  return component;
}
