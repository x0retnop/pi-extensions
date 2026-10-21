/** Classify mid-stream toolcall lags. Pure — no I/O. Written into `diag` rows. */

export const MUT_TOOLS = ["write", "edit", "multi_edit", "insert"] as const;
export type MutToolName = (typeof MUT_TOOLS)[number];

export type ToolVerdict = "provider_buffer" | "progressive" | "header_late" | "unknown";
export type StreamVerdict = "provider_buffer" | "progressive" | "mixed" | "none";
export type UiHint = "blank" | "ellipsis" | "full_pop" | "grow";

export interface ToolLag {
  name: string;
  argBytes: number;
  contentLen: number;
  streamMs: number;
  deltas: number;
  pathAtMs: number | null;
  contentAtMs: number | null;
  oldAtMs: number | null;
  newAtMs: number | null;
}

export interface ToolDiag extends ToolLag {
  verdict: ToolVerdict;
  emptyMs: number;
  how: string;
  path: string | null;
}

const CLUSTER_MS = 50;
const LARGE_BYTES = 500;
const DUMP_DELTAS = 2;
const PROG_DELTAS = 10;
const PROG_STREAM_MS = 400;
const HEADER_LATE_STREAM_MS = 500;
const ELLIPSIS_MS = 200;
const SILENCE_MS = 3000;

export function isMutName(name: string): name is MutToolName {
  return (MUT_TOOLS as readonly string[]).includes(name);
}

export function emptyHeaderMs(t: ToolLag): number {
  if (t.pathAtMs == null) return Math.max(0, t.streamMs);
  return Math.max(0, t.pathAtMs);
}

export function bodyLagMs(t: ToolLag): number {
  if (t.name === "write") {
    if (t.contentAtMs == null || t.pathAtMs == null) return 0;
    return Math.max(0, t.contentAtMs - t.pathAtMs);
  }
  const body = t.newAtMs ?? t.oldAtMs;
  if (body == null || t.pathAtMs == null) return 0;
  return Math.max(0, body - t.pathAtMs);
}

function seenTimes(t: ToolLag): number[] {
  return [t.pathAtMs, t.contentAtMs, t.oldAtMs, t.newAtMs].filter((x): x is number => x != null);
}

/** Path/content/old/new first-seen times sit in a tight window (one dump). */
export function milestonesClustered(t: ToolLag): boolean {
  const times = seenTimes(t);
  if (times.length >= 2) return Math.max(...times) - Math.min(...times) <= CLUSTER_MS;
  if (t.name === "write" && t.pathAtMs != null && t.contentAtMs != null) {
    return Math.abs(t.contentAtMs - t.pathAtMs) <= CLUSTER_MS;
  }
  return t.deltas <= DUMP_DELTAS && (t.pathAtMs === 0 || t.pathAtMs == null);
}

export function classifyTool(t: ToolLag): ToolVerdict {
  const large = t.argBytes >= LARGE_BYTES;
  const clustered = milestonesClustered(t);
  const dumpish = t.deltas <= DUMP_DELTAS;

  // Late/missing path with few deltas = dump before parse. Many deltas = key order
  // (Kimi often emits new_string first) — that is progressive, not a buffer.
  if (dumpish && t.pathAtMs == null && (t.contentLen > 0 || t.argBytes > 200 || t.streamMs > ELLIPSIS_MS)) {
    return "header_late";
  }
  if (
    dumpish &&
    t.pathAtMs != null &&
    t.streamMs >= HEADER_LATE_STREAM_MS &&
    t.pathAtMs >= t.streamMs * 0.8
  ) {
    return "header_late";
  }

  if (large && dumpish && clustered) return "provider_buffer";
  if (t.name === "write" && t.contentLen >= 200 && dumpish && clustered) {
    return "provider_buffer";
  }

  if (t.deltas >= PROG_DELTAS && t.streamMs >= PROG_STREAM_MS) return "progressive";
  if (t.pathAtMs != null && t.pathAtMs <= 100 && bodyLagMs(t) >= 200) return "progressive";

  return "unknown";
}

export function classifyStream(mut: { verdict: ToolVerdict }[]): StreamVerdict {
  if (mut.length === 0) return "none";
  const set = new Set(mut.map((m) => m.verdict));
  const hasBuf = set.has("provider_buffer");
  const hasProg = set.has("progressive");
  if (hasBuf && hasProg) return "mixed";
  if (hasBuf) return "provider_buffer";
  if (hasProg) return "progressive";
  if (set.has("header_late")) return "provider_buffer";
  return "none";
}

export function toolHow(t: ToolLag, verdict: ToolVerdict): string {
  const path = t.pathAtMs == null ? "∅" : `${t.pathAtMs}ms`;
  if (t.name === "write") {
    const content = t.contentAtMs == null ? "∅" : `${t.contentAtMs}ms`;
    return `${verdict} Δ${t.deltas} ${t.argBytes}b path@${path} content@${content} ${t.streamMs}ms`;
  }
  const old = t.oldAtMs == null ? "∅" : `${t.oldAtMs}ms`;
  const neu = t.newAtMs == null ? "∅" : `${t.newAtMs}ms`;
  return `${verdict} Δ${t.deltas} ${t.argBytes}b path@${path} old@${old} new@${neu} ${t.streamMs}ms`;
}

export function toolUi(t: ToolLag, verdict: ToolVerdict): UiHint[] {
  const out: UiHint[] = [];
  if (emptyHeaderMs(t) >= ELLIPSIS_MS) out.push("ellipsis");
  if (verdict === "provider_buffer") out.push("full_pop");
  else if (verdict === "progressive") out.push("grow");
  else if (verdict === "header_late") out.push("ellipsis");
  return out;
}

export function streamUi(silenceMs: number, tools: { ui: UiHint[] }[]): UiHint[] {
  const out: UiHint[] = [];
  if (silenceMs >= SILENCE_MS) out.push("blank");
  const seen = new Set<UiHint>();
  for (const t of tools) {
    for (const h of t.ui) {
      if (h === "blank" || seen.has(h)) continue;
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

export function buildToolDiag(t: ToolLag & { path?: string | null }): ToolDiag {
  const verdict = classifyTool(t);
  return {
    name: t.name,
    argBytes: t.argBytes,
    contentLen: t.contentLen,
    streamMs: t.streamMs,
    deltas: t.deltas,
    pathAtMs: t.pathAtMs,
    contentAtMs: t.contentAtMs,
    oldAtMs: t.oldAtMs,
    newAtMs: t.newAtMs,
    verdict,
    emptyMs: emptyHeaderMs(t),
    how: toolHow(t, verdict),
    path: t.path ?? null,
  };
}

export const SILENCE_THRESHOLD_MS = SILENCE_MS;
