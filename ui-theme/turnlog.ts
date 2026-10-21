/**
 * turnlog — turn-scoped tool timeline (absorbs the archived tool-timestamps).
 *
 * One dim inline entry per finished LLM turn in the chat scrollback, merging
 * the old per-call timestamp rows into a compact turn summary:
 *
 *   08-09 20:09:09  turn 3 · 23.4s · ↑12.3k ↓1.2k R45% $0.012 · 4 tools
 *     ├─ read 45ms · grep 12ms · py 112ms
 *
 * Collapsed shows the first 4 tools on one line; expanded (tool-output-expand
 * mode) lists every tool with its target. Parallel tool calls — the old noise
 * source — collapse into the single turn entry.
 *
 * Plus a live status block during the turn (turn · elapsed · tool count),
 * replacing the hidden Working… row; after the turn it shows the last summary.
 * Per-turn usage (tokens/cache/cost) lives only in the scrollback entry —
 * the footer already shows session totals, duplicating them in the status
 * bar was noise.
 *
 * Implemented as persisted display-only custom entries (appendEntry +
 * registerEntryRenderer): rendered in session order, restored on /resume,
 * never sent to the LLM.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setStatusBlock } from "../common/status.js";
import { trunc } from "./paint.js";
import type { UiThemeSettings } from "./settings.js";

const ENTRY_TYPE = "ui-turn";
const STATUS_KEY = "zz-turn";
const MAX_TARGET = 50;
const MAX_COLLAPSED_TOOLS = 4;
const MAX_STORED = 1000;
const TICK_MS = 1000;

export interface TurnTool {
  tool: string;
  target: string;
  durMs: number;
  isError: boolean;
}

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface TurnRow {
  turnIndex: number;
  startMs: number;
  endMs: number;
  /** Only set when it differs from the previous turn's model. */
  model?: string;
  httpStatus?: number;
  usage?: TurnUsage;
  tools: TurnTool[];
}

interface TurnDeps {
  getSettings: () => UiThemeSettings;
  setSettings: (s: UiThemeSettings) => void;
}

// ---- state ----

let piRef: ExtensionAPI | null = null;
let deps: TurnDeps = {
  getSettings: () => ({ timeline: true, turnLive: true } as UiThemeSettings),
  setSettings: () => {},
};
let currentCtx: ExtensionContext | null = null;
let currentTurn: TurnRow | null = null;
let lastTurnModel: string | undefined;
let lastSummary: string | undefined;
let rows: TurnRow[] = [];
let inlineMode = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
const starts = new Map<string, { time: number; tool: string; target: string }>();

export function setTurnLogDeps(d: TurnDeps): void {
  deps = d;
}

function settings(): UiThemeSettings {
  return deps.getSettings();
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

/** Stable-width turn status: `0.0s` … `99.9s` (then trunc in the cell). */
function fmtStatusDur(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${s.toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

/** Short one-line target hint from tool arguments (path / pattern / command / query). */
function extractTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.pattern ?? a.command ?? a.query ?? a.url ?? "";
  if (typeof v !== "string") return "";
  const s = v.split("\n")[0].trim();
  return s.length > MAX_TARGET ? s.slice(0, MAX_TARGET) + "…" : s;
}

function fmtTool(t: TurnTool): string {
  return `${t.isError ? "✗" : ""}${t.tool} ${fmtDur(t.durMs)}`;
}

function usageParts(u: TurnUsage): string {
  const parts: string[] = [];
  if (u.input) parts.push(`↑${fmtTokens(u.input)}`);
  if (u.output) parts.push(`↓${fmtTokens(u.output)}`);
  // R and W are independent: cacheWrite is only reported by Anthropic-native responses
  // (cache_creation_input_tokens) and the few OpenAI gateways that send cache_write_tokens
  // (OpenRouter). Kimi / xAI / OpenCode Go never do — logging "W0" next to every R implied a
  // measured zero instead of "not reported". Matches footer.ts.
  if (u.cacheRead) parts.push(`R${fmtTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${fmtTokens(u.cacheWrite)}`);
  if (u.cost > 0) parts.push(`$${u.cost.toFixed(3)}`);
  return parts.join(" ");
}

function renderEntryLines(row: TurnRow, expanded: boolean, width: number, theme: any): string[] {
  const err = row.tools.some((t) => t.isError);
  const head: string[] = [
    fmtStamp(row.endMs),
    `${err ? "✗ " : ""}turn ${row.turnIndex}${row.model ? " · " + row.model : ""}`,
    fmtDur(row.endMs - row.startMs),
  ];
  if (row.httpStatus && row.httpStatus >= 400) head.push(`HTTP ${row.httpStatus}`);
  if (row.usage) {
    const ups = usageParts(row.usage);
    if (ups) head.push(ups);
  }
  if (row.tools.length) head.push(`${row.tools.length} tool${row.tools.length === 1 ? "" : "s"}`);
  const lines = [theme.fg("dim", trunc(head.join(" · "), width))];
  if (!row.tools.length) return lines;

  if (expanded) {
    for (const t of row.tools) {
      const target = t.target ? `  ${t.target}` : "";
      lines.push(theme.fg("dim", trunc(`  ├─ ${fmtTool(t)}${target}`, width)));
    }
    return lines;
  }
  const shown = row.tools.slice(0, MAX_COLLAPSED_TOOLS).map(fmtTool).join(" · ");
  const more = row.tools.length - MAX_COLLAPSED_TOOLS;
  lines.push(theme.fg("dim", trunc(`  ├─ ${shown}${more > 0 ? ` · +${more} more` : ""}`, width)));
  return lines;
}

function fmtAllLine(r: TurnRow): string {
  const tools = r.tools.length ? ` · ${r.tools.length} tools` : "";
  const ups = r.usage ? usageParts(r.usage) : "";
  const usage = ups ? ` · ${ups}` : "";
  return `${fmtStamp(r.endMs)}  turn ${r.turnIndex}${r.model ? " · " + r.model : ""} · ${fmtDur(r.endMs - r.startMs)}${usage}${tools}`;
}

// ---- live status ----

function updateLiveStatus(): void {
  if (!settings().turnLive || !currentCtx?.hasUI) return;
  if (currentTurn) {
    const dur = fmtStatusDur(Date.now() - currentTurn.startMs);
    setStatusBlock(currentCtx, STATUS_KEY, `▶ ${dur}`);
  } else if (lastSummary) {
    setStatusBlock(currentCtx, STATUS_KEY, lastSummary);
  } else {
    setStatusBlock(currentCtx, STATUS_KEY, undefined);
  }
}

function startTick(): void {
  if (tickTimer !== undefined) return;
  tickTimer = setInterval(updateLiveStatus, TICK_MS);
}

function stopTick(): void {
  if (tickTimer !== undefined) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
}

// ---- event handlers (wired in index.ts) ----

export function onTurnStart(event: { turnIndex: number; timestamp: number }, ctx: ExtensionContext): void {
  currentCtx = ctx;
  lastSummary = undefined;
  currentTurn = { turnIndex: event.turnIndex, startMs: event.timestamp, endMs: 0, tools: [] };
  const m = ctx.model;
  if (m) currentTurn.model = m.name || m.id || undefined;
  if (settings().turnLive) {
    updateLiveStatus();
    startTick();
  }
}

export function onTurnEnd(event: { message: unknown }, ctx: ExtensionContext): void {
  currentCtx = ctx;
  const turn = currentTurn;
  currentTurn = null;
  stopTick();
  if (!turn) return;
  turn.endMs = Date.now();

  const u = (event.message as any)?.usage as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
    | undefined;
  if (u) {
    turn.usage = {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cost: u.cost?.total ?? 0,
    };
  }

  // Model shown only when it differs from the previous turn (footer already shows it live).
  if (turn.model && turn.model === lastTurnModel) turn.model = undefined;
  if (turn.model) lastTurnModel = turn.model;

  rows.push(turn);
  if (rows.length > MAX_STORED) rows.splice(0, rows.length - MAX_STORED);

  if (settings().timeline && inlineMode && piRef) {
    piRef.appendEntry(ENTRY_TYPE, turn);
  }

  lastSummary = `✓ ${fmtStatusDur(turn.endMs - turn.startMs)}`;
  updateLiveStatus();
}

export function onToolStart(event: { toolCallId: string; toolName: string; args: any }): void {
  starts.set(event.toolCallId, {
    time: Date.now(),
    tool: event.toolName,
    target: extractTarget(event.args),
  });
}

export function onToolEnd(event: { toolCallId: string; toolName: string; isError: boolean }): void {
  const start = starts.get(event.toolCallId);
  starts.delete(event.toolCallId);
  if (!currentTurn) return;
  const now = Date.now();
  currentTurn.tools.push({
    tool: event.toolName,
    target: start?.target ?? "",
    durMs: start ? now - start.time : 0,
    isError: event.isError,
  });
  if (settings().turnLive) updateLiveStatus();
}

export function onProviderResponse(event: { status: number }): void {
  if (currentTurn) currentTurn.httpStatus = event.status;
}

// ---- lifecycle ----

/** Re-apply the live/cleared status after settings changed (menu, presets). */
export function refreshTurnLogStatus(ctx: ExtensionContext): void {
  currentCtx = ctx;
  if (!settings().turnLive) {
    setStatusBlock(ctx, STATUS_KEY, undefined);
  } else {
    updateLiveStatus();
  }
}

/** Backfill /timestamps all from persisted custom entries (startup, /resume). */
export function resetTurnLog(ctx: ExtensionContext): void {
  currentCtx = ctx;
  currentTurn = null;
  lastTurnModel = undefined;
  lastSummary = undefined;
  starts.clear();
  stopTick();
  rows = [];
  try {
    for (const e of ctx.sessionManager.getEntries() as any[]) {
      if (e?.type === "custom" && e.customType === ENTRY_TYPE && e.data && typeof e.data.endMs === "number") {
        rows.push(e.data as TurnRow);
      }
    }
  } catch {
    // no entries access
  }
  rows.sort((a, b) => a.endMs - b.endMs);
  if (rows.length > MAX_STORED) rows.splice(0, rows.length - MAX_STORED);
  updateLiveStatus();
}

export function shutdownTurnLog(): void {
  stopTick();
  if (currentCtx) {
    setStatusBlock(currentCtx, STATUS_KEY, undefined);
  }
  currentCtx = null;
  currentTurn = null;
}

/** Register the scrollback renderer (once at extension load). */
export function registerTurnLogRenderer(pi: ExtensionAPI): void {
  piRef = pi;
  const registerEntryRenderer = (pi as any).registerEntryRenderer as
    | ((customType: string, renderer: (entry: any, options: { expanded: boolean }, theme: any) => any) => void)
    | undefined;
  inlineMode = typeof registerEntryRenderer === "function";
  if (!inlineMode) return;
  registerEntryRenderer(ENTRY_TYPE, (entry, options, theme) => {
    const d = entry?.data as TurnRow | undefined;
    if (!d || typeof d.endMs !== "number") return undefined;
    return {
      render(width: number) {
        return renderEntryLines(d, options.expanded, width, theme);
      },
      invalidate() {},
    };
  });
}

// ---- /timestamps command ----

export async function runTimestampsCommand(args: string, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  currentCtx = ctx;
  const a = (args ?? "").trim().toLowerCase();
  const parts = a.split(/\s+/);
  const head = parts[0] ?? "";

  if (head === "all") {
    if (rows.length === 0) {
      ctx.ui.notify("No turn records yet (turnlog entries appear from now on)", "info");
      return;
    }
    const list = [...rows]
      .sort((x, y) => x.endMs - y.endMs)
      .map(fmtAllLine)
      .reverse();
    await ctx.ui.select(`Turn timeline (${rows.length} turns, newest first)`, list);
    return;
  }

  if (head === "status") {
    const want = parts[1];
    const next = want === "on" ? true : want === "off" ? false : !settings().turnLive;
    applySettings({ ...settings(), turnLive: next }, `turn status → ${next ? "on" : "off"}`);
    return;
  }

  // bare on|off|"" toggles the inline scrollback entries
  const next = head === "on" ? true : head === "off" ? false : !settings().timeline;
  applySettings(
    { ...settings(), timeline: next },
    `turn log entries → ${next ? "on" : "off"} (use "status" for live status, "all" for list)`,
  );
}

function applySettings(s: UiThemeSettings, msg: string): void {
  deps.setSettings(s);
  if (!s.turnLive) {
    setStatusBlock(currentCtx, STATUS_KEY, undefined);
  } else {
    updateLiveStatus();
  }
  ctxNotify(msg);
}

function ctxNotify(msg: string): void {
  try {
    currentCtx?.ui.notify(`timestamps: ${msg}`, "info");
  } catch {
    // ignore
  }
}
