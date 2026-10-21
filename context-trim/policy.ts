/**
 * Superseded full-read trim policy.
 *
 * For each normalized path, keep only the last successful full-file `read`
 * result; replace earlier large full-read result bodies with a fixed stub.
 * Never deletes toolResult messages (wire ids stay intact).
 */

export const DEFAULT_MIN_CHARS = 2000;

/** Fixed stub prefix — stable for prompt-cache after the first apply turn. */
export const STUB_MARKER = "[context-trim]";

export interface TrimOptions {
  /** Only stub full-read results at least this large (chars). Default 2000. */
  minChars?: number;
}

export interface TrimStats {
  stubbed: number;
  charsSaved: number;
  paths: string[];
  /** Paths where a write/edit of the same file sat between first stub and last keep. */
  pathsWithWriteBetween: number;
}

export interface TrimResult {
  messages: any[];
  stats: TrimStats;
  changed: boolean;
}

const WRITE_TOOLS = new Set(["edit", "multi_edit", "insert", "write"]);

export function normalizePath(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  let p = raw.trim().replace(/^["']|["']$/g, "");
  if (!p) return null;
  p = p.replace(/^\/([a-zA-Z])(?=\/)/, (_, d: string) => `${d.toUpperCase()}:`);
  p = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) {
    const drive = p.slice(0, 2).toUpperCase();
    const rest = p.slice(2).replace(/\/+/g, "/");
    p = drive + rest;
  } else {
    p = p.replace(/\/+/g, "/");
  }
  return p.toLowerCase();
}

export function isFullReadArgs(args: Record<string, unknown> | null | undefined): boolean {
  if (!args || typeof args !== "object") return false;
  const mode = String(args.mode ?? "raw").toLowerCase();
  if (mode === "overview" || mode === "section" || mode === "grep" || mode === "headtail") {
    return false;
  }
  if (args.target != null && String(args.target).length > 0) return false;
  if (args.offset !== undefined && args.offset !== null) return false;
  if (args.limit !== undefined && args.limit !== null) return false;
  return true;
}

export function resultTextChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const item of content) {
    if (item && typeof item === "object" && typeof (item as any).text === "string") {
      n += (item as any).text.length;
    }
  }
  return n;
}

export function isAlreadyStubbed(content: unknown): boolean {
  if (typeof content === "string") return content.startsWith(STUB_MARKER);
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0];
  return !!(first && typeof first === "object" && typeof first.text === "string" && first.text.startsWith(STUB_MARKER));
}

export function makeStubText(path: string, originalChars: number): string {
  // Immutable wording so later turns keep the same prefix for cache.
  return (
    `${STUB_MARKER} read ${path} · ${originalChars} chars · ` +
    `superseded by a later full read of the same path`
  );
}

function toolPathFromArgs(args: any): string | null {
  if (!args || typeof args !== "object") return null;
  return normalizePath(args.path ?? args.file_path ?? args.file);
}

interface CallMeta {
  path: string | null;
  isFull: boolean;
  name: string;
  order: number;
}

/**
 * Apply superseded-read stubs. Returns a new messages array when anything changes.
 * Original message objects that are not stubbed are shared by reference.
 */
export function applySupersededReadTrim(
  messages: any[],
  options: TrimOptions = {},
): TrimResult {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const empty: TrimStats = { stubbed: 0, charsSaved: 0, paths: [], pathsWithWriteBetween: 0 };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, stats: empty, changed: false };
  }

  // Pass 1: index read calls by toolCallId; track write orders per path.
  const calls = new Map<string, CallMeta>();
  const writeOrders = new Map<string, number[]>();
  let order = 0;

  for (const msg of messages) {
    const role = msg?.role;
    if (role !== "assistant") {
      order++;
      continue;
    }
    const content = msg?.content;
    if (!Array.isArray(content)) {
      order++;
      continue;
    }
    for (const block of content) {
      if (!block || block.type !== "toolCall") continue;
      const name = String(block.name ?? "");
      const id = String(block.id ?? "");
      const args = block.arguments ?? {};
      const path = toolPathFromArgs(args);
      if (name === "read" && id) {
        calls.set(id, {
          path,
          isFull: isFullReadArgs(args),
          name,
          order,
        });
      } else if (WRITE_TOOLS.has(name) && path) {
        const list = writeOrders.get(path) ?? [];
        list.push(order);
        writeOrders.set(path, list);
      }
      order++;
    }
  }

  // Pass 2: collect full successful read results by path (in message order).
  type Hit = {
    msgIndex: number;
    callId: string;
    path: string;
    chars: number;
    order: number;
    alreadyStub: boolean;
  };
  const byPath = new Map<string, Hit[]>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg?.role;
    if (role !== "toolResult" && role !== "tool_result") continue;
    const toolName = msg?.toolName ?? msg?.tool_name;
    if (toolName !== "read") continue;
    if (msg?.isError) continue;
    const callId = String(msg?.toolCallId ?? msg?.tool_call_id ?? "");
    const meta = calls.get(callId);
    if (!meta?.path || !meta.isFull) continue;
    const chars = resultTextChars(msg.content);
    const hit: Hit = {
      msgIndex: i,
      callId,
      path: meta.path,
      chars,
      order: meta.order,
      alreadyStub: isAlreadyStubbed(msg.content),
    };
    const list = byPath.get(meta.path) ?? [];
    list.push(hit);
    byPath.set(meta.path, list);
  }

  // Decide which message indexes to stub.
  const toStub = new Map<number, { path: string; chars: number }>();
  const pathsStubbed = new Set<string>();
  let pathsWithWrite = 0;

  for (const [path, hits] of byPath) {
    if (hits.length < 2) continue;
    const keep = hits[hits.length - 1];
    const candidates = hits.slice(0, -1).filter((h) => h.chars >= minChars || h.alreadyStub);
    if (candidates.length === 0) continue;

    const firstO = candidates[0].order;
    const lastO = keep.order;
    const writes = writeOrders.get(path) ?? [];
    if (writes.some((w) => firstO < w && w < lastO)) pathsWithWrite++;

    for (const h of candidates) {
      if (h.alreadyStub) {
        // Count as already applied; no rewrite needed for cache stability.
        pathsStubbed.add(path);
        continue;
      }
      if (h.chars < minChars) continue;
      toStub.set(h.msgIndex, { path: h.path, chars: h.chars });
      pathsStubbed.add(path);
    }
  }

  if (toStub.size === 0) {
    // Still report already-stubbed paths if any (status only)
    const already = [...byPath.values()].flat().filter((h) => h.alreadyStub);
    if (already.length === 0) {
      return { messages, stats: empty, changed: false };
    }
    const saved = already.reduce((s, h) => s + Math.max(0, h.chars - makeStubText(h.path, h.chars).length), 0);
    // chars on already-stub is stub length not original — report stubbed count only
    return {
      messages,
      stats: {
        stubbed: already.length,
        charsSaved: 0,
        paths: [...new Set(already.map((h) => h.path))],
        pathsWithWriteBetween: pathsWithWrite,
      },
      changed: false,
    };
  }

  let charsSaved = 0;
  const out = messages.map((msg, i) => {
    const info = toStub.get(i);
    if (!info) return msg;
    const stub = makeStubText(info.path, info.chars);
    charsSaved += Math.max(0, info.chars - stub.length);
    return {
      ...msg,
      content: [{ type: "text", text: stub }],
    };
  });

  return {
    messages: out,
    stats: {
      stubbed: toStub.size,
      charsSaved,
      paths: [...pathsStubbed].sort(),
      pathsWithWriteBetween: pathsWithWrite,
    },
    changed: true,
  };
}

/** Dry-run stats without allocating a full new message list. */
export function estimateTrim(messages: any[], options: TrimOptions = {}): TrimStats {
  const r = applySupersededReadTrim(messages, options);
  return r.stats;
}
