import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  SILENCE_THRESHOLD_MS,
  buildToolDiag,
  classifyStream,
  isMutName,
  streamUi,
  toolUi,
  type ToolDiag,
  type ToolLag,
  type UiHint,
} from "./verdict.js";

/**
 * stream-tool-log — mid-stream toolcall logger.
 *
 * Operator: /streamlog (toggle), /streamlog on, /streamlog off.
 * Agents: ~/.pi/agent/logs/stream-tool/INDEX.json + "ev":"diag" rows.
 */

const EXT = "stream-tool-log";
const LOG_DIR = join(homedir(), ".pi", "agent", "logs", "stream-tool");
const INDEX_NAME = "INDEX.json";
const AGENT_MD_NAME = "AGENT.md";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "streamToolLog";
const SCHEMA = 2;
const FLUSH_EVERY = 16;
const INDEX_CAP = 40;

const AGENT_MD = `# stream-tool-log — agent reader

Operator only toggles \`/streamlog on|off\`. You read the files. Do not ask them to verbose/flush/note.

## Where

\`~/.pi/agent/logs/stream-tool/\`

- \`INDEX.json\` — \`current\` path, per-log verdict counts, \`last\` diag
- \`<sessionStem>.jsonl\` — one file per session (resume appends)
- \`AGENT.md\` — this file

Start: read \`INDEX.json\`. If \`last\` is enough, stop. Else \`rg '"ev":"diag"' <current>\`.

## \`diag\` (one row per mut or long-silent assistant stream)

| field | meaning |
|---|---|
| \`verdict\` | \`provider_buffer\` \\| \`progressive\` \\| \`mixed\` \\| \`none\` |
| \`silenceMs\` | ms before first toolCall. \`>=3000\` → user saw blank (thinking, Working often hidden) |
| \`thinkChars\` / \`textChars\` | visible thinking/text. Tiny think + long silence = encrypted reasoning |
| \`ui\` | what they saw, in order: \`blank\` \\| \`ellipsis\` (\`write ...\`) \\| \`full_pop\` \\| \`grow\` |
| \`mut[]\` | write/edit/multi_edit/insert only |

### \`mut[]\`

| field | meaning |
|---|---|
| \`verdict\` | \`provider_buffer\` \\| \`progressive\` \\| \`header_late\` \\| \`unknown\` |
| \`d\` | toolcall_delta count. \`1\` + large bytes = dump |
| \`pathAt\` / \`contentAt\` / \`oldAt\` / \`newAt\` | ms from that tool's start until field non-empty |
| \`emptyMs\` | ms of \`write ...\` / \`edit ...\` (path empty) |
| \`how\` | one-line greppable reason |

## Blame

- \`provider_buffer\` → provider dumped args. Matches "nothing, then the full file". Not the write renderer.
- \`progressive\` → args grow. Late path + many Δ = JSON key order (\`new_string\` first), not a dump.
- \`header_late\` → path arrived at the end / never, **few** Δ. User saw \`write ...\` the whole generation.
- \`silenceMs\` high + \`thinkChars\` tiny → encrypted thinking, no chrome. ui-theme \`working: false\` makes this look hung.

Kimi/DeepSeek typically \`progressive\`. xAI Grok \`openai-responses\` typically \`provider_buffer\`.

## Other \`ev\` (rarely needed)

\`open\` \`mode\` \`stream\` \`mark\` \`exec\` \`pack\` \`shut\`

Do not re-classify. \`diag.verdict\` is the source of truth.
`;

interface ArgSnap {
  path: string | null;
  pathLen: number;
  contentLen: number;
  oldLen: number;
  newLen: number;
  editsN: number | null;
  argBytes: number;
}

interface ToolTrack {
  key: string;
  id: string;
  name: string;
  contentIndex: number;
  startMs: number;
  firstPathMs?: number;
  firstContentMs?: number;
  firstOldMs?: number;
  firstNewMs?: number;
  deltaCount: number;
  endMs?: number;
  final?: ArgSnap;
}

interface StreamState {
  streamId: number;
  startMs: number;
  model?: string;
  provider?: string;
  api?: string;
  tools: Map<string, ToolTrack>;
  order: string[];
  textChars: number;
  thinkingChars: number;
}

interface IndexLog {
  log: string;
  session: string;
  openedAt: string;
  pid: number;
  diags: number;
  verdicts: Record<string, number>;
  last: Record<string, unknown> | null;
}

interface IndexFile {
  v: number;
  enabled: boolean;
  current: string | null;
  updatedAt: string;
  logs: IndexLog[];
}

function nowMs(): number {
  return Date.now();
}

function iso(ms = nowMs()): string {
  return new Date(ms).toISOString();
}

function safeJsonLen(v: unknown): number {
  try {
    return JSON.stringify(v ?? null).length;
  } catch {
    return -1;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function snapArgs(args: unknown): ArgSnap {
  const a = asRecord(args);
  const path =
    typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
  const content = typeof a.content === "string" ? a.content : null;
  const oldS =
    typeof a.old_string === "string" ? a.old_string : typeof a.oldText === "string" ? a.oldText : null;
  const newS =
    typeof a.new_string === "string" ? a.new_string : typeof a.newText === "string" ? a.newText : null;
  return {
    path,
    pathLen: path?.length ?? 0,
    contentLen: content?.length ?? 0,
    oldLen: oldS?.length ?? 0,
    newLen: newS?.length ?? 0,
    editsN: Array.isArray(a.edits) ? a.edits.length : null,
    argBytes: Math.max(0, safeJsonLen(args)),
  };
}

function toolKey(id: string | undefined, contentIndex: number, name: string): string {
  if (id && id.length > 0) return id;
  return `idx:${contentIndex}:${name || "?"}`;
}

/** Indexed block only — never fall back to a previous tool (false path@0). */
function extractToolCall(
  partial: any,
  contentIndex: number,
): { id: string; name: string; args: unknown } | null {
  const block = partial?.content?.[contentIndex];
  if (!block || block.type !== "toolCall") return null;
  return { id: String(block.id ?? ""), name: String(block.name ?? ""), args: block.arguments };
}

function shortPath(p: string | null | undefined, max = 96): string | null {
  if (!p) return null;
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

function safeStem(raw: string): string {
  const s = raw.replace(/[:/\\]+/g, "-").replace(/\s+/g, "_");
  return s.slice(0, 80) || "unknown";
}

function loadEnabled(): boolean {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    const block = raw[SETTINGS_KEY];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const en = (block as Record<string, unknown>).enabled;
      if (typeof en === "boolean") return en;
    }
  } catch {
    /* missing / broken settings → off */
  }
  return false;
}

function saveEnabled(enabled: boolean): void {
  let all: Record<string, unknown> = {};
  try {
    if (existsSync(SETTINGS_PATH)) {
      all = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    }
  } catch {
    all = {};
  }
  const prev =
    all[SETTINGS_KEY] && typeof all[SETTINGS_KEY] === "object" && !Array.isArray(all[SETTINGS_KEY])
      ? (all[SETTINGS_KEY] as Record<string, unknown>)
      : {};
  all[SETTINGS_KEY] = { ...prev, enabled };
  try {
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function readIndex(): IndexFile {
  try {
    const raw = JSON.parse(readFileSync(join(LOG_DIR, INDEX_NAME), "utf8")) as IndexFile;
    if (raw && typeof raw === "object" && Array.isArray(raw.logs)) return raw;
  } catch {
    /* missing */
  }
  return { v: SCHEMA, enabled: false, current: null, updatedAt: iso(), logs: [] };
}

function writeIndex(idx: IndexFile): void {
  try {
    writeFileSync(join(LOG_DIR, INDEX_NAME), `${JSON.stringify(idx, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function ensureAgentMd(): void {
  try {
    writeFileSync(join(LOG_DIR, AGENT_MD_NAME), AGENT_MD, "utf8");
  } catch {
    /* ignore */
  }
}

function trackToLag(tr: ToolTrack, endMs: number): ToolLag & { path: string | null } {
  const f = tr.final ?? snapArgs(null);
  return {
    name: tr.name,
    argBytes: f.argBytes,
    contentLen: f.contentLen,
    streamMs: endMs - tr.startMs,
    deltas: tr.deltaCount,
    pathAtMs: tr.firstPathMs !== undefined ? tr.firstPathMs - tr.startMs : null,
    contentAtMs: tr.firstContentMs !== undefined ? tr.firstContentMs - tr.startMs : null,
    oldAtMs: tr.firstOldMs !== undefined ? tr.firstOldMs - tr.startMs : null,
    newAtMs: tr.firstNewMs !== undefined ? tr.firstNewMs - tr.startMs : null,
    path: shortPath(f.path),
  };
}

export default function (pi: ExtensionAPI) {
  let enabled = loadEnabled();
  let logPath: string | undefined;
  let sessionStem = "unknown";
  let streamId = 0;
  let stream: StreamState | undefined;
  let buf: string[] = [];
  let execStarts = new Map<string, { ms: number; name: string; snap: ArgSnap }>();
  let batchExec: { streamId: number; starts: number[]; ends: number[] } | undefined;
  let indexEntry: IndexLog | undefined;

  function emitRaw(rec: Record<string, unknown>, tMs = nowMs()): void {
    if (!logPath) return;
    if (!enabled && rec.ev !== "mode") return;
    const line = JSON.stringify({ v: SCHEMA, t: iso(tMs), ms: tMs, ...rec });
    buf.push(line);
    if (buf.length >= FLUSH_EVERY) flush(true);
  }

  function flush(_force = false): void {
    if (!logPath || buf.length === 0) return;
    const chunk = `${buf.join("\n")}\n`;
    buf = [];
    try {
      appendFileSync(logPath, chunk, "utf8");
    } catch {
      /* drop rather than throw into the agent loop */
    }
  }

  function openLog(stem: string, ctx?: ExtensionContext): void {
    mkdirSync(LOG_DIR, { recursive: true });
    ensureAgentMd();
    sessionStem = safeStem(stem);
    logPath = join(LOG_DIR, `${sessionStem}.jsonl`);
    let sessionFile: string | null = null;
    try {
      sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
    } catch {
      sessionFile = null;
    }
    const t = nowMs();
    indexEntry = {
      log: logPath,
      session: sessionFile ?? sessionStem,
      openedAt: iso(t),
      pid: process.pid,
      diags: 0,
      verdicts: {},
      last: null,
    };
    const idx = readIndex();
    idx.enabled = enabled;
    idx.current = logPath;
    idx.updatedAt = iso(t);
    idx.logs = [indexEntry, ...idx.logs.filter((l) => l.log !== logPath)].slice(0, INDEX_CAP);
    writeIndex(idx);
    try {
      writeFileSync(join(LOG_DIR, "LATEST.txt"), `${logPath}\n`, "utf8");
    } catch {
      /* ignore */
    }
    emitRaw(
      {
        ev: "open",
        schema: SCHEMA,
        logPath,
        sessionFile,
        sessionStem,
        pid: process.pid,
        cwd: process.cwd(),
      },
      t,
    );
    flush(true);
  }

  function ensureLog(ctx?: ExtensionContext): void {
    if (!enabled) return;
    let stem = sessionStem;
    try {
      const f = ctx?.sessionManager?.getSessionFile?.();
      if (f) stem = basename(f, ".jsonl");
    } catch {
      /* keep */
    }
    const next = safeStem(stem);
    if (!logPath || next !== sessionStem) openLog(next, ctx);
  }

  function bumpIndex(diag: {
    sid: number;
    verdict: string;
    provider: string | null;
    model: string | null;
    silenceMs: number;
    ui: UiHint[];
  }): void {
    if (!indexEntry || !logPath) return;
    indexEntry.diags += 1;
    indexEntry.verdicts[diag.verdict] = (indexEntry.verdicts[diag.verdict] ?? 0) + 1;
    indexEntry.last = diag;
    const idx = readIndex();
    idx.enabled = enabled;
    idx.current = logPath;
    idx.updatedAt = iso();
    const rest = idx.logs.filter((l) => l.log !== logPath);
    idx.logs = [indexEntry, ...rest].slice(0, INDEX_CAP);
    writeIndex(idx);
  }

  function setUiStatus(ctx: ExtensionContext | undefined): void {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.setStatus(EXT, enabled ? "stl" : undefined);
    } catch {
      /* ignore */
    }
  }

  function notify(ctx: ExtensionContext, msg: string): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(msg, "info");
    } catch {
      /* ignore */
    }
  }

  function setEnabled(next: boolean, ctx: ExtensionContext): void {
    if (enabled === next) {
      notify(ctx, next ? "stream-tool-log ON" : "stream-tool-log OFF");
      return;
    }
    enabled = next;
    saveEnabled(enabled);
    setUiStatus(ctx);
    try {
      const idx = readIndex();
      idx.enabled = enabled;
      idx.updatedAt = iso();
      writeIndex(idx);
    } catch {
      /* ignore */
    }
    if (enabled) {
      ensureLog(ctx);
      emitRaw({ ev: "mode", on: true });
      flush(true);
      notify(ctx, "stream-tool-log ON");
    } else {
      emitRaw({ ev: "mode", on: false });
      flush(true);
      notify(ctx, "stream-tool-log OFF");
    }
  }

  function startStream(message: any): void {
    streamId += 1;
    const t = nowMs();
    stream = {
      streamId,
      startMs: t,
      model: message?.model,
      provider: message?.provider,
      api: message?.api,
      tools: new Map(),
      order: [],
      textChars: 0,
      thinkingChars: 0,
    };
    batchExec = { streamId, starts: [], ends: [] };
    execStarts.clear();
    emitRaw(
      {
        ev: "stream",
        sid: streamId,
        model: stream.model ?? null,
        provider: stream.provider ?? null,
        api: stream.api ?? null,
      },
      t,
    );
  }

  function trackFromPartial(
    contentIndex: number,
    partial: any,
    kind: "start" | "delta" | "end",
    _delta?: string,
    toolCallEnd?: any,
  ): void {
    if (!stream || !enabled) return;
    const t = nowMs();

    let id = "";
    let name = "";
    let args: unknown = {};
    if (kind === "end" && toolCallEnd) {
      id = String(toolCallEnd.id ?? "");
      name = String(toolCallEnd.name ?? "");
      args = toolCallEnd.arguments;
    } else {
      const tc = extractToolCall(partial, contentIndex);
      if (!tc) return;
      id = tc.id;
      name = tc.name;
      args = tc.args;
    }

    const key = toolKey(id, contentIndex, name);
    let tr = stream.tools.get(key);
    if (!tr && id) {
      const idxKey = `idx:${contentIndex}:${name || "?"}`;
      const orphan = stream.tools.get(idxKey);
      if (orphan) {
        stream.tools.delete(idxKey);
        orphan.id = id;
        orphan.key = key;
        stream.tools.set(key, orphan);
        const oi = stream.order.indexOf(idxKey);
        if (oi >= 0) stream.order[oi] = key;
        tr = orphan;
      }
    }

    const snap = snapArgs(args);
    if (!tr) {
      tr = {
        key,
        id: id || key,
        name: name || "?",
        contentIndex,
        startMs: t,
        deltaCount: 0,
      };
      stream.tools.set(key, tr);
      stream.order.push(key);
    } else {
      if (id && tr.id !== id) tr.id = id;
      if (name && tr.name !== name) tr.name = name;
    }

    if (kind === "delta") tr.deltaCount += 1;

    const mark = (milestone: string, first: number | undefined, set: (ms: number) => void): void => {
      if (first !== undefined) return;
      set(t);
      emitRaw(
        {
          ev: "mark",
          sid: stream!.streamId,
          id: tr!.id,
          name: tr!.name,
          which: milestone,
          atMs: t - tr!.startMs,
          bytes: snap.argBytes,
          path: shortPath(snap.path),
        },
        t,
      );
    };
    if (snap.pathLen > 0) mark("path", tr.firstPathMs, (ms) => { tr!.firstPathMs = ms; });
    if (snap.contentLen > 0) mark("content", tr.firstContentMs, (ms) => { tr!.firstContentMs = ms; });
    if (snap.oldLen > 0) mark("old", tr.firstOldMs, (ms) => { tr!.firstOldMs = ms; });
    if (snap.newLen > 0) mark("new", tr.firstNewMs, (ms) => { tr!.firstNewMs = ms; });

    if (kind === "end") {
      tr.endMs = t;
      tr.final = snap;
    }
  }

  function endStream(message: any): void {
    if (!stream) return;
    const t = nowMs();
    const usage = message?.usage || {};

    let firstTcMs: number | null = null;
    for (const k of stream.order) {
      const tr = stream.tools.get(k)!;
      if (firstTcMs === null || tr.startMs < firstTcMs) firstTcMs = tr.startMs;
    }
    const silenceMs = firstTcMs !== null ? firstTcMs - stream.startMs : t - stream.startMs;

    const mut: ToolDiag[] = [];
    for (const k of stream.order) {
      const tr = stream.tools.get(k)!;
      if (!isMutName(tr.name)) continue;
      mut.push(buildToolDiag(trackToLag(tr, tr.endMs ?? t)));
    }

    const longSilence = silenceMs >= SILENCE_THRESHOLD_MS;
    if (mut.length > 0 || longSilence) {
      const withUi = mut.map((m) => ({ ...m, ui: toolUi(m, m.verdict) }));
      const verdict = classifyStream(mut);
      const ui = streamUi(silenceMs, withUi);
      const diag = {
        ev: "diag",
        sid: stream.streamId,
        provider: (message?.provider ?? stream.provider ?? null) as string | null,
        model: (message?.model ?? stream.model ?? null) as string | null,
        api: (message?.api ?? stream.api ?? null) as string | null,
        verdict,
        silenceMs,
        thinkChars: stream.thinkingChars,
        textChars: stream.textChars,
        outTok: usage.output ?? usage.outputTokens ?? null,
        streamMs: t - stream.startMs,
        ui,
        mut: withUi.map((m) => ({
          name: m.name,
          verdict: m.verdict,
          bytes: m.argBytes,
          content: m.contentLen,
          streamMs: m.streamMs,
          d: m.deltas,
          pathAt: m.pathAtMs,
          contentAt: m.contentAtMs,
          oldAt: m.oldAtMs,
          newAt: m.newAtMs,
          emptyMs: m.emptyMs,
          how: m.how,
          path: m.path,
        })),
      };
      emitRaw(diag, t);
      bumpIndex({
        sid: stream.streamId,
        verdict,
        provider: diag.provider,
        model: diag.model,
        silenceMs,
        ui,
      });
    }

    flush(true);
    stream = undefined;
  }

  pi.on("session_start", async (_e, ctx) => {
    setUiStatus(ctx);
    if (!enabled) return;
    ensureLog(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (!enabled) return;
    emitRaw({ ev: "shut" });
    flush(true);
  });

  pi.on("message_start", async (e, ctx) => {
    if (!enabled) return;
    ensureLog(ctx);
    const msg = (e as any).message;
    if (msg?.role !== "assistant") return;
    startStream(msg);
  });

  pi.on("message_update", async (e) => {
    if (!enabled) return;
    if (!stream) {
      const msg = (e as any).message;
      if (msg?.role === "assistant") startStream(msg);
      else return;
    }
    const ame = (e as any).assistantMessageEvent;
    if (!ame || !ame.type) return;
    const typ = ame.type as string;
    const partial = ame.partial;

    if (typ === "text_delta" && typeof ame.delta === "string") {
      stream!.textChars += ame.delta.length;
      return;
    }
    if (typ === "text_end" && typeof ame.content === "string") {
      stream!.textChars = Math.max(stream!.textChars, ame.content.length);
      return;
    }
    if (typ === "thinking_delta" && typeof ame.delta === "string") {
      stream!.thinkingChars += ame.delta.length;
      return;
    }
    if (typ === "thinking_end" && typeof ame.content === "string") {
      stream!.thinkingChars = Math.max(stream!.thinkingChars, ame.content.length);
      return;
    }
    if (typ === "toolcall_start") {
      trackFromPartial(ame.contentIndex, partial, "start");
      return;
    }
    if (typ === "toolcall_delta") {
      trackFromPartial(ame.contentIndex, partial, "delta", typeof ame.delta === "string" ? ame.delta : "");
      return;
    }
    if (typ === "toolcall_end") {
      trackFromPartial(ame.contentIndex, partial, "end", undefined, ame.toolCall);
    }
  });

  pi.on("message_end", async (e) => {
    if (!enabled) return;
    const msg = (e as any).message;
    if (msg?.role !== "assistant") return;
    if (!stream) {
      startStream(msg);
      const content = msg?.content;
      if (Array.isArray(content)) {
        content.forEach((b: any, idx: number) => {
          if (b?.type === "toolCall") trackFromPartial(idx, msg, "end", undefined, b);
        });
      }
    }
    endStream(msg);
  });

  pi.on("tool_execution_start", async (e) => {
    if (!enabled) return;
    const t = nowMs();
    const id = String((e as any).toolCallId ?? "");
    const name = String((e as any).toolName ?? "");
    const snap = snapArgs((e as any).args);
    execStarts.set(id, { ms: t, name, snap });
    if (batchExec) batchExec.starts.push(t);
    emitRaw(
      {
        ev: "exec",
        phase: "start",
        id,
        name,
        sid: stream?.streamId ?? batchExec?.streamId ?? null,
        path: shortPath(snap.path),
      },
      t,
    );
  });

  pi.on("tool_execution_end", async (e) => {
    if (!enabled) return;
    const t = nowMs();
    const id = String((e as any).toolCallId ?? "");
    const name = String((e as any).toolName ?? "");
    const st = execStarts.get(id);
    execStarts.delete(id);
    if (batchExec) batchExec.ends.push(t);
    emitRaw(
      {
        ev: "exec",
        phase: "end",
        id,
        name,
        sid: stream?.streamId ?? batchExec?.streamId ?? null,
        durMs: st ? t - st.ms : null,
        err: Boolean((e as any).isError),
      },
      t,
    );

    if (batchExec && execStarts.size === 0 && batchExec.ends.length > 0 && batchExec.starts.length > 0) {
      const startMin = Math.min(...batchExec.starts);
      const endMax = Math.max(...batchExec.ends);
      emitRaw(
        {
          ev: "pack",
          sid: batchExec.streamId,
          n: batchExec.ends.length,
          spreadMs: Math.max(...batchExec.ends) - Math.min(...batchExec.ends),
          wallMs: endMax - startMin,
        },
        t,
      );
      batchExec = undefined;
      flush(true);
    }
  });

  pi.registerCommand("streamlog", {
    description: "stream-tool-log on/off (toggle)",
    handler: async (args, ctx) => {
      const c = (args || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (c === "on") {
        setEnabled(true, ctx);
        return;
      }
      if (c === "off") {
        setEnabled(false, ctx);
        return;
      }
      if (!c) {
        setEnabled(!enabled, ctx);
        return;
      }
      notify(ctx, enabled ? "stream-tool-log ON  —  /streamlog off" : "stream-tool-log OFF  —  /streamlog on");
    },
  });
}
