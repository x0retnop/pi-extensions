import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * tool-timestamps — TUI-only timeline of tool executions.
 *
 * Modes (cycle with /timestamps):
 * - compact (default): one dim line above the editor with the latest event
 *     07-14 18:17:38  bash (119ms)  ls "/c/..."  ·  24 events
 * - expanded: up to 8 recent rows
 * - hidden: widget removed
 *
 * /timestamps all opens a scrollable list with every event of the session.
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
const MAX_STORED = 1000;

type Mode = "compact" | "expanded" | "hidden";

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

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return sameDay ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
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

function fmtRow(r: Row): string {
  const dur = r.durMs !== undefined ? ` (${fmtDur(r.durMs)})` : "";
  const mark = r.isError ? "✗ " : "";
  return `${fmtStamp(r.time)}  ${mark}${r.tool}${dur}${r.target ? "  " + r.target : ""}`;
}

export default function (pi: ExtensionAPI) {
  const rows: Row[] = [];
  const starts = new Map<string, { time: number; tool: string; target: string }>();
  let mode: Mode = "compact";

  function renderWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (mode === "hidden" || rows.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    if (mode === "compact") {
      const r = rows[rows.length - 1];
      const dur = r.durMs !== undefined ? ` (${fmtDur(r.durMs)})` : "";
      const mark = r.isError ? "✗ " : "";
      ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
        render(width: number) {
          const line = `${fmtTime(r.time)}  ${mark}${r.tool}${dur}${r.target ? "  " + r.target : ""}  ·  ${rows.length} events`;
          return [theme.fg("dim", truncate(line, width))];
        },
        invalidate() {},
      }));
      return;
    }
    const visible = rows.slice(-MAX_ROWS);
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      render(width: number) {
        return visible.map((r) => theme.fg("dim", truncate(fmtRow(r), width)));
      },
      invalidate() {},
    }));
  }

  function pushRow(ctx: ExtensionContext, row: Row): void {
    rows.push(row);
    if (rows.length > MAX_STORED) rows.splice(0, rows.length - MAX_STORED);
    renderWidget(ctx);
  }

  pi.registerCommand("timestamps", {
    description: "Tool timeline: cycle widget mode, or 'all' for scrollable full list",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "all") {
        if (rows.length === 0) {
          ctx.ui.notify("No tool executions recorded yet", "info");
          return;
        }
        // Scrollable full list, oldest first. Enter/Esc closes — viewer only.
        await ctx.ui.select(
          `Tool timeline (${rows.length} events)`,
          rows.map(fmtRow)
        );
        return;
      }
      if (arg === "off") mode = "hidden";
      else if (arg === "on") mode = "compact";
      else mode = mode === "compact" ? "expanded" : mode === "expanded" ? "hidden" : "compact";
      renderWidget(ctx);
      ctx.ui.notify(`timestamps: ${mode}`, "info");
    },
  });

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
    if (rows.length > MAX_STORED) rows.splice(0, rows.length - MAX_STORED);
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
