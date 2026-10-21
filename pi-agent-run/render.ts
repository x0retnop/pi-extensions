import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { highlightCodeSafe } from "./highlighter.js";
import type { ToolSettings } from "./settings.js";
import { formatDuration } from "../common/duration.js";

/** Max visible width for a single code preview line (ANSI-aware via pi-tui), collapsed rows only. */
export const PREVIEW_LINE_WIDTH = 120;

/**
 * Pi's own "to expand" hint with the user's real binding; a literal fallback outside the TUI (and in
 * tests), where the theme singleton is not initialized. Same helper as `sub-agents/index.ts` — the
 * repo does not import across extensions.
 */
function expandHint(): string {
  try {
    const bound = keyText("app.tools.expand").replace(/\x1b\[[0-9;]*m/g, "").trim();
    return bound ? keyHint("app.tools.expand", "to expand") : "Ctrl+O to expand";
  } catch {
    return "Ctrl+O to expand";
  }
}

/**
 * truncateToWidth terminates a truncated line with `\x1b[0m` (full SGR reset).
 * Pi's Box paints the block background by wrapping the whole line in a bg
 * color, so that mid-line reset wipes the background from the ellipsis to the
 * right edge ("torn" background). All styling here is fg/bold-only, so
 * downgrading the reset to bold-off + fg-reset is safe and keeps the Box
 * background intact.
 */
function truncatePreview(line: string, maxWidth: number): string {
  return truncateToWidth(line, maxWidth).replaceAll("\x1b[0m", "\x1b[22m\x1b[39m");
}

/**
 * Body of the `pwsh>` / `py>` row.
 *
 * Collapsed: at most `previewLines` lines, each clipped at `PREVIEW_LINE_WIDTH` columns with `…`.
 * Expanded (Ctrl+O): the whole code, unwrapped by us — no line cap and no character clip, so a long
 * one-liner is readable to its end instead of ending in `…` (the bash row has always worked this
 * way: the cap is for the collapsed row, never the only view of a command).
 */
export function formatCodeBody(
  code: string,
  toolSettings: ToolSettings,
  theme: Theme,
  tool?: "pwsh" | "py",
  opts: { expanded?: boolean } = {},
): string[] {
  if (!code) {
    return [theme.fg("toolOutput", "...")];
  }

  const lines = toolSettings.highlight
    ? highlightCodeSafe(code, toolSettings.highlightMode, theme, tool)
    : code.split("\n").map((line) => theme.fg("toolOutput", line));

  if (opts.expanded === true) {
    return lines;
  }

  const limit = toolSettings.previewLines;
  const clipped = lines.length <= limit ? lines : lines.slice(0, limit);
  const truncated = clipped.map((line) => truncatePreview(line, PREVIEW_LINE_WIDTH));

  if (lines.length <= limit) {
    return truncated;
  }

  const more = lines.length - limit;
  const suffix = theme.fg("muted", `… +${more} line${more === 1 ? "" : "s"}`);
  return [...truncated, suffix];
}

export function formatCodeCall(
  tool: "pwsh" | "py",
  code: string,
  toolSettings: ToolSettings,
  timeout: number | undefined,
  theme: Theme,
  elapsedMs?: number,
  opts: { expanded?: boolean } = {},
): string {
  const label = tool === "pwsh" ? "pwsh" : "py";
  const prefix = theme.fg("toolTitle", theme.bold(`${label}>`));
  const timeoutSuffix = timeout
    ? theme.fg("muted", ` (timeout ${formatDuration(timeout * 1000)})`)
    : "";
  const elapsedSuffix =
    elapsedMs !== undefined ? theme.fg("muted", ` ${formatDuration(elapsedMs)}`) : "";

  const bodyLines = formatCodeBody(code, toolSettings, theme, tool, opts);
  return `${prefix}${timeoutSuffix}${elapsedSuffix}\n${bodyLines.join("\n")}`;
}

/**
 * ANSI escapes a child process may emit: OSC (`ESC ] … BEL|ST`) and CSI/Fe (`ESC [ … final`), the
 * same two families Pi's own `stripAnsi` covers.
 */
const ANSI_ESCAPE_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c)|[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/** C0 controls Pi also drops, plus `\r`; `\t` (Text expands it) and `\n` (the line split) stay. */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\ufff9-\ufffb]/g;

/**
 * Strip the child process's own styling before the row styles the text. PowerShell emits SGR even
 * with `-OutputFormat Text` (measured on this host: `\x1b[32;1mProcessId : \x1b[0m6040`, CRLF
 * endings); colorama/rich and pytest do the same under `py`. Pi's own result path strips all of it
 * (`getTextOutput` in `core/tools/render-utils.js`: stripAnsi → sanitizeBinaryOutput → CR strip), so
 * a custom `renderResult` that skips it breaks the row twice:
 *
 * - the block background is a single wrap (`theme.bg(token, line)` = `<bg>line\x1b[49m`), and a
 *   child's mid-line `\x1b[0m` resets it — everything right of the reset (usually the whole value
 *   column) draws on the terminal's own background: the "black, half-filled row";
 * - `Text` goes through `wrapTextWithAnsi`, which splits on `/\r\n|\r|\n/`, so a raw CR ends the line
 *   a second time and each CRLF output line leaves a stray empty row.
 */
function sanitizeProcessOutput(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_RE, "");
}

/**
 * Result body: the output as the extension's own guard left it — a bounded tail of the real output
 * plus its `[Showing lines …]` summary as the last line — previewed from the **end**.
 *
 * Pi's generic fallback (used while this row had no `renderResult`) shows the first 10 lines, which
 * for a guarded run means the beginning of the kept tail: the least useful slice, and the summary
 * that carries the spill path sat below the cut. The tail is what a shell row must show, and the
 * summary is always the last line here, so a collapsed row can never hide the fact that output was
 * truncated or where the full log went. `previewLines` (the setting behind `/agent-run`) decides how
 * much of the tail is kept; Ctrl+O shows everything.
 */
export function formatCodeResultLines(
  text: string,
  toolSettings: ToolSettings,
  theme: Theme,
  opts: { expanded?: boolean } = {},
): string[] {
  const body = sanitizeProcessOutput(text).replace(/\s+$/, "");
  if (!body) return [];
  const lines = body.split("\n");
  if (opts.expanded === true || lines.length <= toolSettings.previewLines) {
    return ["", ...lines.map((line) => theme.fg("toolOutput", line))];
  }

  const limit = Math.max(1, toolSettings.previewLines);
  const hidden = lines.length - limit;
  const hint = theme.fg("muted", `... (${hidden} earlier line${hidden === 1 ? "" : "s"}, `) +
    `${expandHint()}${theme.fg("muted", ")")}`;
  return ["", ...lines.slice(hidden).map((line) => theme.fg("toolOutput", line)), hint];
}

/** Call slot component: one Text, reused across renders so the row never jumps. */
export function codeCallComponent(text: string, context: { lastComponent?: unknown }): Text {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(text);
  return component;
}

/** Result slot component: the same Container, refilled on every render. */
export function codeResultComponent(lines: string[], context: { lastComponent?: unknown }): Container {
  const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
  component.clear();
  if (lines.length > 0) component.addChild(new Text(lines.join("\n"), 0, 0));
  return component;
}
