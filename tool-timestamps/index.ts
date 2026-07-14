import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * tool-timestamps — TUI-only timeline of tool executions.
 *
 * On Pi >= 0.80.4 each finished tool call gets a dim inline row right below it
 * in the chat scrollback:
 *   07-14 18:17:38  bash (119ms)  ls "/c/..."
 * Implemented as persisted display-only session entries (pi.appendEntry +
 * registerEntryRenderer): rendered in session order, restored on /resume,
 * never sent to the LLM. Ctrl+O (global expand) reveals a result snippet.
 *
 * On older Pi the extension falls back to a widget above the editor
 * (modes: compact / expanded / hidden, cycle with /timestamps).
 *
 * /timestamps all opens a scrollable list with every tool call of the session.
 */

const ENTRY_TYPE = "tool-timestamp";
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
  snippet?: string; // first result lines, inline mode only
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

/** First meaningful result lines, control chars stripped. Kept small — persisted in the session file. */
function extractSnippet(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const joined = content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string)
    .join("\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return joined
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 2)
    .map((l) => truncate(l.trim(), 120))
    .join("\n");
}

function fmtRow(r: Row): string {
  const dur = r.durMs !== undefined ? ` (${fmtDur(r.durMs)})` : "";
  const mark = r.isError ? "✗ " : "";
  return `${fmtStamp(r.time)}  ${mark}${r.tool}${dur}${r.target ? "  " + r.target : ""}`;
}

export default function (pi: ExtensionAPI) {
  // Entry renderers exist on Pi >= 0.80.4. Cast: repo types may lag behind.
  const registerEntryRenderer = (pi as any).registerEntryRenderer as
    | ((customType: string, renderer: (entry: any, options: { expanded: boolean }, theme: any) => any) => void)
    | undefined;
  const inlineMode = typeof registerEntryRenderer === "function";

  const rows: Row[] = []; // for /timestamps all and the widget fallback
  const starts = new Map<string, { time: number; tool: string; target: string }>();
  let mode: Mode = "compact";

  if (inlineMode) {
    registerEntryRenderer(ENTRY_TYPE, (entry, options, theme) => {
      const d = entry.data as Row | undefined;
      if (!d || typeof d.time !== "number") return undefined;
      return {
        render(width: number) {
          const lines = [theme.fg("dim", truncate(fmtRow(d), width))];
          if (options.expanded && d.snippet) {
            for (const sl of d.snippet.split("\n")) {
              lines.push(theme.fg("dim", truncate(`    ↳ ${sl}`, width)));
            }
          }
          return lines;
        },
        invalidate() {},
      };
    });
  }

  // ---- widget fallback (Pi < 0.80.4) ----

  function renderWidget(ctx: ExtensionContext): void {
    if (inlineMode || !ctx.hasUI) return;
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

  // ---- data collection ----

  function recordRow(ctx: ExtensionContext, row: Row): void {
    rows.push(row);
    if (rows.length > MAX_STORED) rows.splice(0, rows.length - MAX_STORED);
    if (inlineMode) {
      pi.appendEntry(ENTRY_TYPE, row);
    } else {
      renderWidget(ctx);
    }
  }

  pi.registerCommand("timestamps", {
    description: "Tool timeline: 'all' for scrollable full list; on old Pi also cycles widget mode",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "all") {
        if (rows.length === 0) {
          ctx.ui.notify("No tool executions recorded yet", "info");
          return;
        }
        // Scrollable full list, oldest first. Enter/Esc closes — viewer only.
        await ctx.ui.select(`Tool timeline (${rows.length} events)`, rows.map(fmtRow));
        return;
      }
      if (inlineMode) {
        ctx.ui.notify("timestamps: inline mode (Pi >= 0.80.4). Use /timestamps all for the full list.", "info");
        return;
      }
      if (arg === "off") mode = "hidden";
      else if (arg === "on") mode = "compact";
      else mode = mode === "compact" ? "expanded" : mode === "expanded" ? "hidden" : "compact";
      renderWidget(ctx);
      ctx.ui.notify(`timestamps: ${mode}`, "info");
    },
  });

  // Rebuild the rows list from session history (startup, /resume, /new, /fork).
  // Inline rows themselves come from persisted entries and need no backfill.
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
    recordRow(ctx, {
      time: now,
      tool: event.toolName,
      target: start?.target ?? "",
      durMs: start ? now - start.time : undefined,
      isError: event.isError,
      snippet: inlineMode ? extractSnippet(event.result) : undefined,
    });
  });
}
