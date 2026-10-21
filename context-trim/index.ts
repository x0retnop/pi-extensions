/**
 * context-trim — manual one-shot superseded full-read trim.
 *
 * /trim preview  — estimate only
 * /trim          — compute stubs now; apply them on every LLM call until /trim clear
 * /trim clear    — drop stubs (model sees full reads again)
 * /trim status   — show active stub count / last stats
 * /trim min N    — size threshold for the next /trim
 *
 * No auto-enable on resume/idle. Session JSONL is never rewritten.
 * Stubs are a fixed map (toolCallId → text) frozen at /trim time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setStatusBlock } from "../common/status.js";
import {
  DEFAULT_MIN_CHARS,
  applySupersededReadTrim,
  estimateTrim,
  isAlreadyStubbed,
  makeStubText,
  type TrimStats,
} from "./policy.js";

const STATE_TYPE = "context-trim-state";
const STATUS_KEY = "ctx-trim";

/** Frozen stubs from the last `/trim` (toolCallId → stub body). */
type StubMap = Record<string, string>;

interface PersistedState {
  minChars: number;
  /** toolCallId → stub text; empty = inactive */
  stubs: StubMap;
  lastStats?: TrimStats;
}

function defaultState(): PersistedState {
  return { minChars: DEFAULT_MIN_CHARS, stubs: {} };
}

function stubCount(s: PersistedState): number {
  return Object.keys(s.stubs).length;
}

function readStateFromSession(ctx: any): PersistedState {
  const base = defaultState();
  try {
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "custom" && e?.customType === STATE_TYPE && e?.data) {
        const d = e.data as Partial<PersistedState> & { enabled?: boolean };
        const stubs =
          d.stubs && typeof d.stubs === "object" && !Array.isArray(d.stubs)
            ? (d.stubs as StubMap)
            : {};
        return {
          minChars:
            typeof d.minChars === "number" && d.minChars > 0
              ? Math.floor(d.minChars)
              : DEFAULT_MIN_CHARS,
          stubs,
          lastStats: d.lastStats,
        };
      }
    }
  } catch {
    // ignore
  }
  return base;
}

function persistState(pi: ExtensionAPI, state: PersistedState): void {
  try {
    pi.appendEntry(STATE_TYPE, {
      minChars: state.minChars,
      stubs: state.stubs,
      lastStats: state.lastStats,
    });
  } catch {
    // ignore
  }
}

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatStats(s: TrimStats): string {
  if (s.stubbed <= 0) return "nothing to stub";
  return `${s.stubbed} reads · −${formatChars(s.charsSaved)} chars · ${s.paths.length} path(s)`;
}

function showStatus(ctx: any, state: PersistedState): void {
  const n = stubCount(state);
  if (n <= 0) {
    setStatusBlock(ctx, STATUS_KEY, undefined);
    return;
  }
  const saved = state.lastStats?.charsSaved;
  const label =
    saved && saved > 0 ? `trim:${n}·${formatChars(saved)}` : `trim:${n}`;
  setStatusBlock(ctx, STATUS_KEY, label);
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(`[context-trim] ${message}`, level);
    }
  } catch {
    // ignore
  }
}

/** Live agent messages if exposed; else reconstruct from session branch. */
function getLlmMessages(ctx: any): any[] {
  try {
    const fromAgent = ctx?.agent?.state?.messages;
    if (Array.isArray(fromAgent) && fromAgent.length > 0) return fromAgent;
  } catch {
    // ignore
  }
  try {
    const entries =
      ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
    const out: any[] = [];
    for (const e of entries) {
      if (e?.type === "message" && e?.message) out.push(e.message);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build a frozen stub map from current messages (one-shot compute).
 * Keys are toolCallId of the superseded full reads.
 */
function buildStubMap(messages: any[], minChars: number): {
  stubs: StubMap;
  stats: TrimStats;
} {
  const result = applySupersededReadTrim(messages, { minChars });
  const stubs: StubMap = {};

  // Walk original + result to capture callIds and original sizes for stub text.
  for (let i = 0; i < messages.length; i++) {
    const before = messages[i];
    const after = result.messages[i];
    const role = before?.role;
    if (role !== "toolResult" && role !== "tool_result") continue;
    if ((before?.toolName ?? before?.tool_name) !== "read") continue;
    const callId = String(before?.toolCallId ?? before?.tool_call_id ?? "");
    if (!callId) continue;

    const afterText =
      Array.isArray(after?.content) && after.content[0]?.text
        ? String(after.content[0].text)
        : "";
    if (!afterText.startsWith("[context-trim]")) continue;

    // Prefer the computed stub; if message was already stubbed, keep it.
    stubs[callId] = afterText;
  }

  // If apply reported already-stubbed only (changed=false but stubbed>0), recover from content.
  if (Object.keys(stubs).length === 0 && result.stats.stubbed > 0) {
    for (const msg of messages) {
      const role = msg?.role;
      if (role !== "toolResult" && role !== "tool_result") continue;
      if ((msg?.toolName ?? msg?.tool_name) !== "read") continue;
      if (!isAlreadyStubbed(msg.content)) continue;
      const callId = String(msg?.toolCallId ?? msg?.tool_call_id ?? "");
      if (!callId) continue;
      const text =
        Array.isArray(msg.content) && msg.content[0]?.text
          ? String(msg.content[0].text)
          : makeStubText("?", 0);
      stubs[callId] = text;
    }
  }

  return { stubs, stats: result.stats };
}

/** Apply frozen stub map to a message list (LLM view only). */
function applyStubMap(messages: any[], stubs: StubMap): { messages: any[]; applied: number } {
  const ids = Object.keys(stubs);
  if (ids.length === 0) return { messages, applied: 0 };

  let applied = 0;
  const out = messages.map((msg) => {
    const role = msg?.role;
    if (role !== "toolResult" && role !== "tool_result") return msg;
    if ((msg?.toolName ?? msg?.tool_name) !== "read") return msg;
    const callId = String(msg?.toolCallId ?? msg?.tool_call_id ?? "");
    const stub = stubs[callId];
    if (!stub) return msg;
    if (isAlreadyStubbed(msg.content)) {
      // Ensure exact frozen text
      const cur =
        Array.isArray(msg.content) && msg.content[0]?.text
          ? String(msg.content[0].text)
          : "";
      if (cur === stub) return msg;
    }
    applied++;
    return {
      ...msg,
      content: [{ type: "text", text: stub }],
    };
  });

  return { messages: applied > 0 ? out : messages, applied };
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUB_AGENTS_CHILD === "1") {
    return;
  }

  let state: PersistedState = defaultState();

  pi.on("session_start", async (_event, ctx) => {
    state = readStateFromSession(ctx);
    showStatus(ctx, state);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = readStateFromSession(ctx);
    showStatus(ctx, state);
  });

  // Only re-inject the frozen map from the last manual /trim. No discovery here.
  pi.on("context", (event, ctx) => {
    if (stubCount(state) === 0) return undefined;
    const { messages, applied } = applyStubMap(event.messages, state.stubs);
    if (applied > 0) showStatus(ctx, state);
    if (messages === event.messages) return undefined;
    return { messages };
  });

  pi.registerCommand("trim", {
    description:
      "One-shot superseded full-read trim. /trim | preview | clear | status | min N. Manual only.",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const cmd = (parts[0] ?? "").toLowerCase();

      if (cmd === "preview" || cmd === "dry" || cmd === "dry-run") {
        const est = estimateTrim(getLlmMessages(ctx), { minChars: state.minChars });
        notify(
          ctx,
          est.stubbed > 0
            ? `preview: ${formatStats(est)} · run /trim to apply`
            : "preview: nothing to stub (need 2+ full reads of the same path)",
        );
        return;
      }

      if (cmd === "clear" || cmd === "off" || cmd === "undo" || cmd === "reset") {
        state.stubs = {};
        state.lastStats = undefined;
        persistState(pi, state);
        showStatus(ctx, state);
        notify(ctx, "cleared — model sees full read results again on next turn");
        return;
      }

      if (cmd === "status" || cmd === "stat") {
        const est = estimateTrim(getLlmMessages(ctx), { minChars: state.minChars });
        const n = stubCount(state);
        const lines = [
          n > 0 ? `active stubs: ${n}` : "active stubs: none",
          `minChars: ${state.minChars}`,
          `if re-run /trim now: ${formatStats(est)}`,
        ];
        if (state.lastStats && n > 0) {
          lines.push(`last /trim: ${formatStats(state.lastStats)}`);
        }
        notify(ctx, lines.join(" · "));
        return;
      }

      if (cmd === "min") {
        const n = Number(parts[1]);
        if (!Number.isFinite(n) || n < 0) {
          notify(ctx, `usage: /trim min <chars>  (current ${state.minChars})`, "warning");
          return;
        }
        state.minChars = Math.floor(n);
        persistState(pi, state);
        const est = estimateTrim(getLlmMessages(ctx), { minChars: state.minChars });
        notify(ctx, `minChars=${state.minChars} · preview: ${formatStats(est)}`);
        return;
      }

      if (cmd === "help" || cmd === "?") {
        notify(
          ctx,
          "usage: /trim · /trim preview · /trim clear · /trim status · /trim min N",
        );
        return;
      }

      // Bare /trim or unknown → treat as apply (only bare or explicit "apply")
      if (cmd !== "" && cmd !== "apply" && cmd !== "go" && cmd !== "now") {
        notify(
          ctx,
          "usage: /trim · /trim preview · /trim clear · /trim status · /trim min N",
          "warning",
        );
        return;
      }

      // ── one-shot apply ──
      const messages = getLlmMessages(ctx);
      const { stubs, stats } = buildStubMap(messages, state.minChars);

      if (Object.keys(stubs).length === 0) {
        state.stubs = {};
        state.lastStats = stats;
        persistState(pi, state);
        showStatus(ctx, state);
        notify(
          ctx,
          "nothing to stub (need 2+ full reads of the same path, each ≥ minChars)",
        );
        return;
      }

      state.stubs = stubs;
      state.lastStats = stats;
      persistState(pi, state);
      showStatus(ctx, state);
      notify(
        ctx,
        `applied: ${formatStats(stats)} · frozen until /trim clear · next model call uses stubs`,
      );
    },
  });
}
