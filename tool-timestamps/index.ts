import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * tool-timestamps — TUI-only timeline of tool executions.
 *
 * Shows a dim widget above the editor with one row per finished tool call:
 *   07-14 15:32:01  bash (2.3s)  npm test
 *
 * Rows come from two sources:
 * - session entries (read-only scan on session_start) — covers /resume history;
 * - live tool_execution_start/end events — adds duration for new calls.
 *
 * Nothing is registered, overridden, persisted, or sent to the LLM.
 */

const WIDGET_KEY = "tool-timestamps";
const MAX_ROWS = 8; // TUI caps widgets at 10 lines
const MAX_TARGET = 50;

interface Row {
  time: number; // Unix ms
  tool: string;
  target: string;
  durMs?: number; // live calls only
  isError?: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

/** Short one-line target hint from tool arguments (path / pattern / command / query). */
function extractTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.pattern ?? a.command ?? a.query ?? a.url ?? "";
  if (typeof v !== "string") return "";
  return truncate(v.split("\n")[0].trim(), MAX_TARGET);
}

export default function (pi: ExtensionAPI) {
  const rows: Row[] = [];
  const starts = new Map<string, { time: number; tool: string; target: string }>();

  function renderWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (rows.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const visible = rows.slice(-MAX_ROWS);
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      render(width: number) {
        return visible.map((r) => {
          const dur = r.durMs !== undefined ? ` (${fmtDur(r.durMs)})` : "";
          const mark = r.isError ? "✗ " : "";
          const line = `${fmtStamp(r.time)}  ${mark}${r.tool}${dur}${r.target ? "  " + r.target : ""}`;
          return theme.fg("dim", truncate(line, width));
        });
      },
      invalidate() {},
    }));
  }

  function pushRow(ctx: ExtensionContext, row: Row): void {
    rows.push(row);
    if (rows.length > 200) rows.splice(0, rows.length - 200);
    renderWidget(ctx);
  }

  // Rebuild rows from session history (startup, /resume, /new, /fork).
  pi.on("session_start", (_event, ctx) => {
    rows.length = 0;
    starts.clear();
    const calls = new Map<string, { tool: string; target: string }>();
    let entries: unknown[];
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return;
    }
    for (const e of entries as any[]) {
      if (e?.type !== "message") continue;
      const m = e.message;
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "toolCall" && b.id) {
            calls.set(b.id, { tool: String(b.name ?? "?"), target: extractTarget(b.arguments) });
          }
        }
      } else if (m?.role === "toolResult") {
        const c = calls.get(m.toolCallId);
        const time = typeof m.timestamp === "number" ? m.timestamp : Date.parse(e.timestamp);
        if (!Number.isFinite(time)) continue;
        rows.push({
          time,
          tool: String(m.toolName ?? c?.tool ?? "?"),
          target: c?.target ?? "",
          isError: !!m.isError,
        });
      }
    }
    rows.sort((a, b) => a.time - b.time);
    if (rows.length > 200) rows.splice(0, rows.length - 200);
    renderWidget(ctx);
  });

  pi.on("tool_execution_start", (event) => {
    starts.set(event.toolCallId, {
      time: Date.now(),
      tool: event.toolName,
      target: extractTarget(event.args),
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const start = starts.get(event.toolCallId);
    starts.delete(event.toolCallId);
    const now = Date.now();
    pushRow(ctx, {
      time: now,
      tool: event.toolName,
      target: start?.target ?? "",
      durMs: start ? now - start.time : undefined,
      isError: event.isError,
    });
  });
}
