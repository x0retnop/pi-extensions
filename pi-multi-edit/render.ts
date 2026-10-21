import { Box, Text } from "@earendil-works/pi-tui";

export type ShellState = "pending" | "success" | "error";

function bgToken(state: ShellState): string {
  return state === "pending" ? "toolPendingBg" : state === "error" ? "toolErrorBg" : "toolSuccessBg";
}

/**
 * Derive the shell background state the same way ToolExecutionComponent does
 * for renderShell "default": partial -> pending, then success/error.
 * renderCall receives state via context; renderResult via options.isPartial + context.isError.
 */
export function shellState(context: any, options?: any): ShellState {
  const isPartial = options?.isPartial ?? context?.isPartial ?? true;
  if (isPartial) return "pending";
  return context?.isError ? "error" : "success";
}

/**
 * renderShell "self" gets no colored Box from Pi (verified: tool-execution.js
 * only applies bgFn to the default-shell contentBox). Paint it ourselves with
 * pi-tui Box/Text, mirroring the built-in edit renderer. Never pad strings
 * manually (width miscounts crash the TUI) — Box/Text pad to width safely.
 */
export function makeCallComponent(text: string, state: ShellState, theme: any) {
  const box = new Box(1, 1, (line: string) => theme.bg(bgToken(state), line));
  box.addChild(new Text(text, 0, 0));
  return box;
}

export function makeResultComponent(text: string, state: ShellState, theme: any) {
  return new Text(text, 1, 0, (line: string) => theme.bg(bgToken(state), line));
}

function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function resolvePath(args: Record<string, unknown>): string | undefined {
  return typeof args.path === "string" && args.path ? args.path : undefined;
}

function editCount(args: Record<string, unknown>): number {
  if (Array.isArray(args.edits)) return args.edits.length;
  return 1;
}

function insertLine(args: Record<string, unknown>): number | undefined {
  return typeof args.insert_line === "number" ? args.insert_line : undefined;
}

function hasReplaceAll(args: Record<string, unknown>): boolean {
  if (args.replace_all === true) return true;
  if (Array.isArray(args.edits)) {
    return args.edits.some(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).replace_all === true,
    );
  }
  return false;
}

function strLen(v: unknown): number {
  return typeof v === "string" ? v.length : 0;
}

/** Bytes already visible in partial args (Kimi often emits new/old before path). */
export function incomingSizes(args: Record<string, unknown>): { newLen: number; oldLen: number } {
  let newLen = strLen(args.new_string) || strLen(args.newText);
  let oldLen = strLen(args.old_string) || strLen(args.oldText);
  if (Array.isArray(args.edits)) {
    for (const item of args.edits) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      newLen += strLen(rec.new_string) || strLen(rec.newText);
      oldLen += strLen(rec.old_string) || strLen(rec.oldText);
    }
  }
  return { newLen, oldLen };
}

function fmtSize(n: number): string {
  if (n < 1000) return String(n);
  const tenths = Math.round(n / 100) / 10;
  return `${tenths}k`;
}

/** One-line size hint while path is still empty. Empty string once path exists. */
export function streamSizeHint(args: Record<string, unknown>): string {
  if (resolvePath(args)) return "";
  const { newLen, oldLen } = incomingSizes(args);
  if (newLen <= 0 && oldLen <= 0) return "";
  const bits: string[] = [];
  if (newLen > 0) bits.push(`+${fmtSize(newLen)}`);
  if (oldLen > 0) bits.push(`-${fmtSize(oldLen)}`);
  return bits.join(" ");
}

/**
 * Result row on success: the file's line delta (`+12 -3`), read from `details.stats` — the LCS of
 * the file before/after, so a rewritten line reads as `-1 +1` even though the file grew (diff.ts).
 * Placeholder "done" when the result carries no stats: that is the no-change success (identical
 * old/new string), and the body must never render empty — a 0 → N height change flashes the TUI.
 * The hint in the call row above is characters of the arriving arguments, not lines; it exists
 * only until `path` lands.
 */
export function formatResultLine(details: unknown, theme: any): string {
  const stats = (details as { stats?: { added?: number; removed?: number } } | undefined)?.stats;
  const added = typeof stats?.added === "number" ? stats.added : 0;
  const removed = typeof stats?.removed === "number" ? stats.removed : 0;
  if (added <= 0 && removed <= 0) return theme.fg("dim", "done");
  const bits: string[] = [];
  if (added > 0) bits.push(`+${added}`);
  if (removed > 0) bits.push(`-${removed}`);
  return theme.fg("dim", bits.join(" "));
}

export function formatCallHeader(name: string, args: Record<string, unknown>, theme: any): string {
  const path = resolvePath(args);
  const target = path ? shortenPath(path) : "...";
  const count = editCount(args);
  const line = insertLine(args);
  const suffix = hasReplaceAll(args) ? ", replace_all" : "";
  const countLabel = name === "multi_edit" ? `(${count}${suffix})` : "";
  const lineLabel = name === "insert" && line !== undefined ? `(line ${line})` : "";
  const grow = streamSizeHint(args);
  return [
    theme.fg("toolTitle", theme.bold(name)),
    theme.fg("accent", target),
    countLabel ? theme.fg("dim", countLabel) : "",
    lineLabel ? theme.fg("dim", lineLabel) : "",
    grow ? theme.fg("dim", grow) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

