/**
 * payload-trace — manual, on-demand capture of everything sent to / received
 * from the LLM provider.
 *
 * OFF by default: zero writes, zero overhead. Only when you run
 * `/payload-trace start` does it open a capture folder and dump:
 *
 *  - `req-<seq>-<ts>.json`        — the FULL provider request payload
 *                                   (system + tools + messages), as built by pi
 *                                   at `before_provider_request`.
 *  - `resp-<seq>-<ts>.json`       — the FULL parsed response for that call
 *                                   (`turn_end` AgentMessage: text, thinking,
 *                                   tool calls, usage, stopReason + toolResults).
 *  - `trace.jsonl`                — compact per-event records joining the files:
 *                                   seq, provider/model, sys/tools/roles hashes,
 *                                   headers (x-session-affinity/-id), HTTP
 *                                   status per attempt (retries included),
 *                                   token usage + cacheRead + miss flag.
 *
 * The dumps are raw JSON — analysis is a separate step (a Python parser script),
 * not this extension's job.
 *
 * Commands:
 *  /payload-trace start   — open a capture folder (~/.pi/agent/logs/payload-trace/cap-<ts>-<pid>/)
 *  /payload-trace stop    — close it, report path + call/byte counts in chat
 *  /payload-trace status  — current state (on/off, dir, counts)
 *
 * Notes:
 *  - Read-only: never mutates the payload/headers/response.
 *  - Retries: `before_provider_headers` / `after_provider_response` fire per
 *    HTTP attempt for the same request seq — trace records each status.
 *  - Sub-agent processes run without this extension — main session only.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".pi", "agent", "logs", "payload-trace");

interface Capture {
  dir: string;
  seq: number;
  calls: number;
  bytes: number;
  startedAt: string;
  lastTs: string;
}

let capture: Capture | null = null;
/** seq of the most recent request, for correlating status/turn records */
let lastReqSeq = 0;
let lastReqModel = "";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

function nowTs(): string {
  return new Date().toISOString();
}

function fileStamp(ts: string): string {
  // 2026-08-11T15:04:33.123Z -> 20260811-150433-123 (Windows-safe, no colons)
  const [d, t] = ts.split("T");
  const [hms, ms] = t.split(".");
  return `${d.replaceAll("-", "")}-${hms.replaceAll(":", "")}-${(ms ?? "000").slice(0, 3)}`;
}

function notify(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  const msg = text.startsWith("[payload-trace]") ? text : `[payload-trace] ${text}`;
  if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
    ctx.ui.notify(msg, level);
    return;
  }
  (level === "error" ? console.error : level === "warning" ? console.warn : console.log)(msg);
}

function writeJson(dir: string, name: string, obj: unknown): number {
  try {
    const text = JSON.stringify(obj, null, 2);
    writeFileSync(join(dir, name), text, "utf-8");
    return text.length;
  } catch (err) {
    try {
      const fallback = `[payload-trace] failed to serialize ${name}: ${String(err)}\n${String(obj)}`;
      writeFileSync(join(dir, name), fallback, "utf-8");
      return fallback.length;
    } catch {
      return 0;
    }
  }
}

function appendTrace(entry: Record<string, unknown>): void {
  if (!capture) return;
  try {
    appendFileSync(join(capture.dir, "trace.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    /* never break the request path */
  }
}

/** Anthropic-style top-level `system`; OpenAI-style first `system` message. */
function extractSystemPrompt(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, any>;
  if (p.system !== undefined) {
    if (typeof p.system === "string") return p.system;
    if (Array.isArray(p.system)) {
      return p.system.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
    }
  }
  if (Array.isArray(p.messages)) {
    const sys = p.messages.find((m: any) => m?.role === "system");
    if (sys) {
      if (typeof sys.content === "string") return sys.content;
      if (Array.isArray(sys.content)) {
        return sys.content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
      }
    }
  }
  return "";
}

/** Last block type of the last message — distinguishes a fresh user turn from a tool-result continuation. */
function lastMsgBlockType(msg: any): string {
  const c = msg?.content;
  if (typeof c === "string") return "text";
  if (!Array.isArray(c) || c.length === 0) return "-";
  const b = c[c.length - 1];
  return b?.type ?? "other";
}

export default function payloadTrace(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (!capture) return;
    try {
      const payload = (event as any).payload as Record<string, any> | undefined;
      const provider = (ctx as any).model?.provider ?? "?";
      const model = (ctx as any).model?.id ?? "?";
      capture.seq += 1;
      const seq = capture.seq;
      lastReqSeq = seq;
      lastReqModel = model;

      const ts = nowTs();
      capture.lastTs = ts;
      capture.calls += 1;

      const sys = extractSystemPrompt(payload);
      const tools = Array.isArray(payload?.tools) ? JSON.stringify(payload.tools) : "";
      const msgs = Array.isArray(payload?.messages) ? (payload.messages as any[]) : [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;

      const reqName = `req-${String(seq).padStart(4, "0")}-${fileStamp(ts)}.json`;
      capture.bytes += writeJson(capture.dir, reqName, payload);

      appendTrace({
        t: "req",
        seq,
        ts,
        provider,
        model,
        sys: sha256(sys).slice(0, 16),
        tools: sha256(tools).slice(0, 16),
        roles: sha256(msgs.map((m: any) => m?.role ?? "?").join(",")).slice(0, 16),
        n: msgs.length,
        last: lastMsg?.role ?? "-",
        lastType: lastMsg ? lastMsgBlockType(lastMsg) : "-",
        file: reqName,
      });
    } catch {
      /* never break the request path */
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!capture) return;
    try {
      const h = (event as any).headers as Record<string, string> | undefined;
      if (!h) return;
      appendTrace({
        t: "headers",
        ts: nowTs(),
        provider: (ctx as any).model?.provider ?? "?",
        model: (ctx as any).model?.id ?? "?",
        seq: lastReqSeq,
        affinity: h["x-session-affinity"] ?? null,
        sess: h["x-session-id"] ?? null,
        n: Object.keys(h).length,
      });
    } catch {
      /* ignore */
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!capture) return;
    try {
      const e = event as any;
      const h = (e.headers as Record<string, string>) ?? {};
      appendTrace({
        t: "status",
        ts: nowTs(),
        provider: (ctx as any).model?.provider ?? "?",
        model: (ctx as any).model?.id ?? "?",
        seq: lastReqSeq,
        status: e.status ?? null,
        affinity: h["x-session-affinity"] ?? null,
        sess: h["x-session-id"] ?? null,
      });
    } catch {
      /* ignore */
    }
  });

  pi.on("turn_end", (event, ctx) => {
    if (!capture) return;
    try {
      const e = event as any;
      const m = e.message as any;
      if (!m) return;
      const ts = nowTs();
      const seq = lastReqSeq;

      const respName = `resp-${String(seq).padStart(4, "0")}-${fileStamp(ts)}.json`;
      capture.bytes += writeJson(capture.dir, respName, { message: m, toolResults: e.toolResults ?? [] });

      const u = m?.usage;
      const input = u?.input ?? 0;
      const cr = u?.cacheRead ?? 0;
      appendTrace({
        t: "turn",
        ts,
        seq,
        turn: e.turnIndex,
        provider: (ctx as any).model?.provider ?? "?",
        model: (ctx as any).model?.id ?? "?",
        in: input,
        cr,
        out: u?.output ?? 0,
        miss: cr === 0 && input > 0,
        stopReason: m?.stopReason ?? null,
        file: respName,
      });
    } catch {
      /* ignore */
    }
  });

  pi.registerCommand("payload-trace", {
    description:
      "Manual full payload capture. start | stop | status. Dumps to ~/.pi/agent/logs/payload-trace/cap-<ts>-<pid>/",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "start") {
        if (capture) {
          notify(ctx, `capture already ON → ${capture.dir}`);
          return;
        }
        const ts = nowTs();
        const dir = join(LOG_DIR, `cap-${fileStamp(ts)}-${process.pid}`);
        try {
          mkdirSync(dir, { recursive: true });
        } catch (err) {
          notify(ctx, `failed to create ${dir}: ${String(err)}`, "error");
          return;
        }
        capture = { dir, seq: 0, calls: 0, bytes: 0, startedAt: ts, lastTs: ts };
        lastReqSeq = 0;
        lastReqModel = "";
        notify(ctx, `capture ON → ${dir} (writing full request/response payloads)`);
        return;
      }

      if (arg === "stop") {
        if (!capture) {
          notify(ctx, "capture is OFF (nothing to stop)");
          return;
        }
        const c = capture;
        capture = null;
        notify(
          ctx,
          `capture OFF → ${c.dir}: ${c.calls} provider calls · ${(c.bytes / 1024 / 1024).toFixed(2)} MB · ` +
            `started ${c.startedAt} · last ${c.lastTs} · trace.jsonl inside the folder`,
        );
        return;
      }

      // status (also bare /payload-trace)
      if (!capture) {
        notify(ctx, "capture OFF — use /payload-trace start to begin full payload capture");
        return;
      }
      notify(
        ctx,
        `capture ON → ${capture.dir}: ${capture.calls} provider calls · ${(capture.bytes / 1024 / 1024).toFixed(2)} MB · ` +
          `last ${capture.lastTs}`,
      );
    },
  });
}
