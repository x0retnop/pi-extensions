/**
 * Shared session-history outline formatter.
 *
 * Converts raw Pi session entries into a compact, continuation-friendly markdown
 * outline that preserves full user/assistant dialogue while compressing tool
 * interactions into action summaries.
 *
 * Design goals:
 * - Never truncate inside a user or assistant message.
 * - Preserve chronology and timestamps.
 * - Reduce tool results to status + first meaningful line only.
 * - Keep the format identical for /handoff and pi-session-memory outline export.
 */

export interface OutlineMessageContent {
  type: "text" | "thinking" | "toolCall" | "image";
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, any>;
}

export type OutlineEntry =
  | OutlineMessageEntry
  | OutlineToolResultEntry
  | OutlineBashEntry
  | OutlineSummaryEntry
  | OutlineCustomEntry;

export interface OutlineMessageEntry {
  kind: "message";
  role: "user" | "assistant";
  timestamp?: number;
  text: string;
  toolCalls: Array<{ name: string; summary: string }>;
  thinking?: string;
}

export interface OutlineToolResultEntry {
  kind: "toolResult";
  toolName: string;
  timestamp?: number;
  isError: boolean;
  summary: string;
}

export interface OutlineBashEntry {
  kind: "bash";
  timestamp?: number;
  command: string;
  summary: string;
  isError: boolean;
}

export interface OutlineSummaryEntry {
  kind: "summary";
  subtype: "compaction" | "branch";
  timestamp?: number;
  text: string;
}

export interface OutlineCustomEntry {
  kind: "custom";
  customType: string;
  timestamp?: number;
  text: string;
}

export interface FormatOutlineOptions {
  /** Hard character cap for the returned markdown. Entire entries are dropped from the
   *  middle when the limit is exceeded, never partial entries. */
  maxChars?: number;
  /** Maximum characters to keep from a single tool result summary. */
  maxToolResultChars?: number;
  /** Include timestamps in headers. */
  includeTimestamps?: boolean;
  /** Include a compact legend at the top. */
  includeLegend?: boolean;
}

export const DEFAULT_OUTLINE_OPTIONS: Required<FormatOutlineOptions> = {
  maxChars: 65_000,
  maxToolResultChars: 240,
  includeTimestamps: true,
  includeLegend: true,
};

function formatTimestamp(ts: number | undefined): string {
  if (ts === undefined || Number.isNaN(ts)) return "";
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push(block.text);
    }
  }
  return out.join("\n\n");
}

export function extractToolCallsFromContent(
  content: unknown,
): Array<{ name: string; arguments?: Record<string, any> }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; arguments?: Record<string, any> }> = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") {
      out.push({ name: block.name, arguments: block.arguments });
    }
  }
  return out;
}

export function shortToolDescription(name: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return name;
  const a = args as Record<string, any>;
  if (name === "read" && (a.path || a.file_path)) {
    return `read ${a.path || a.file_path}`;
  }
  if (name === "edit" && (a.path || a.file_path)) {
    return `edit ${a.path || a.file_path}`;
  }
  if (name === "write" && (a.path || a.file_path)) {
    return `write ${a.path || a.file_path}`;
  }
  if (name === "grep" && (a.path || a.pattern)) {
    return `grep ${a.pattern || ""} ${a.path || ""}`.trim();
  }
  if (name === "bash") {
    const cmd = a.command || "";
    const heredocMatch = cmd.match(/cat\s*<<\s*['"]?\w+['"]?[\s\S]*?>\s*(\S+)/);
    if (heredocMatch) return `bash heredoc → ${heredocMatch[1]}`;
    const pyMatch = cmd.match(/python(?:3)?\s+(-c\s+['"][^'"]+['"]|\S+\.py)/);
    if (pyMatch) return `python ${pyMatch[1]}`;
    const firstWord = cmd.split(/\s+/)[0];
    return `bash: ${firstWord}${cmd.length > firstWord.length ? " …" : ""}`;
  }
  const firstKey = Object.keys(a).find((k) => a[k] !== undefined);
  if (!firstKey) return name;
  const val = a[firstKey];
  const preview =
    typeof val === "string" ? val.slice(0, 40) : JSON.stringify(val).slice(0, 40);
  const suffix =
    (typeof val === "string" && val.length > 40) || JSON.stringify(val).length > 40 ? "…" : "";
  return `${name} ${firstKey}=${preview}${suffix}`;
}

function formatToolResultSummary(toolName: string, text: string, isError: boolean, maxLen: number): string {
  const status = isError ? "❌" : "✅";
  const first = text.trim().split(/\r?\n/)[0] || "";
  const preview = first.slice(0, maxLen) + (first.length > maxLen ? "…" : "");
  return `${status} ${toolName}${preview ? `: ${preview}` : ""}`;
}

function firstLine(text: string, maxLen: number): string {
  const line = text.split(/\r?\n/)[0]?.trim() || "";
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen) + "…";
}

export function renderOutlineEntry(entry: OutlineEntry, options: Required<FormatOutlineOptions>): string {
  const ts = options.includeTimestamps ? formatTimestamp(entry.timestamp) : "";
  const tsSuffix = ts ? ` — ${ts}` : "";

  switch (entry.kind) {
    case "message": {
      const label = entry.role === "user" ? "User" : "Assistant";
      const lines: string[] = [];
      lines.push(`## ${label}${tsSuffix}`);
      lines.push("");
      lines.push(entry.text);
      if (entry.thinking?.trim()) {
        lines.push("");
        lines.push("*Internal note: model reasoning was emitted but is omitted from this outline.*");
      }
      if (entry.toolCalls.length > 0) {
        lines.push("");
        lines.push("**Actions:**");
        for (const t of entry.toolCalls) lines.push(`- ${t.summary}`);
      }
      return lines.join("\n");
    }
    case "toolResult": {
      return `## ${entry.summary}${tsSuffix}`;
    }
    case "bash": {
      const status = entry.isError ? "❌" : "✅";
      return `## ${status} bash: ${entry.summary}${tsSuffix}`;
    }
    case "summary": {
      const label = entry.subtype === "compaction" ? "Context compaction" : "Branch summary";
      const lines: string[] = [`## ${label}${tsSuffix}`, ""];
      lines.push(entry.text);
      return lines.join("\n");
    }
    case "custom": {
      return `## Custom (${entry.customType})${tsSuffix}\n\n${entry.text}`;
    }
  }
}

// llama-server silently truncates the prompt at the first NUL (0x00) byte in
// message content (verified 2026-07-14, build b9902). Session history can
// contain binary/UTF-16 tool output (e.g. a UTF-16 .ini read as text) — strip
// C0 controls except \n\r\t so the outline can never carry a NUL downstream.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function formatHistoryOutline(
  entries: OutlineEntry[],
  options: FormatOutlineOptions = {},
): string {
  const opts = { ...DEFAULT_OUTLINE_OPTIONS, ...options };

  const blocks = entries
    .map((e) => renderOutlineEntry(e, opts))
    .filter((b) => b.length > 0)
    .map((b) => b + "\n\n---\n\n");

  if (blocks.length === 0) {
    return "*No usable session history.*";
  }

  const legend = opts.includeLegend
    ? "_Legend: ✅ success / ❌ error. Tool results are compressed to status + first line; use session_memory to retrieve full details._\n\n---\n\n"
    : "";

  const headRoom = legend.length;
  const available = Math.max(0, opts.maxChars - headRoom);

  // Keep prefix and suffix of entries; drop whole entries from the middle.
  const takePrefix = (limit: number): string[] => {
    const out: string[] = [];
    let chars = 0;
    for (const block of blocks) {
      if (chars + block.length > limit) break;
      chars += block.length;
      out.push(block);
    }
    return out;
  };

  const takeSuffix = (limit: number): string[] => {
    const out: string[] = [];
    let chars = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (chars + block.length > limit) break;
      chars += block.length;
      out.unshift(block);
    }
    return out;
  };

  // Allocate more room to the suffix (recent history) because it is usually
  // more relevant for continuation.
  const headLimit = Math.floor(available * 0.2);
  const tailLimit = available - headLimit;

  const head = takePrefix(headLimit);
  const tail = takeSuffix(tailLimit);

  const headEnd = head.length;
  const tailStart = blocks.length - tail.length;
  const skipped = tailStart - headEnd;

  let body: string;
  if (skipped <= 0) {
    body = blocks.join("");
  } else {
    body = [
      ...head,
      `## [${skipped} intermediate entries omitted]\n\nFull session is available via the Pi session file or session_memory tool.\n\n---\n\n`,
      ...tail,
    ].join("");
  }

  const result = (legend + body).replace(CONTROL_CHARS_RE, "");
  return result.length > opts.maxChars ? result.slice(0, opts.maxChars) : result;
}

// ---------------------------------------------------------------------------
// Helpers for converting runtime-specific shapes into OutlineEntry.
// ---------------------------------------------------------------------------

export interface RuntimeSessionEntry {
  type?: string;
  timestamp?: number | string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
  toolName?: string;
  name?: string;
  content?: unknown;
  isError?: boolean;
  customType?: string;
  data?: unknown;
  summary?: string;
  command?: string;
  result?: {
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
  };
}

function extractAssistantToolCalls(content: unknown): Array<{ name: string; summary: string }> {
  const calls = extractToolCallsFromContent(content);
  return calls.map((c) => ({
    name: c.name,
    summary: shortToolDescription(c.name, c.arguments),
  }));
}

function parseTimestamp(ts: number | string | undefined): number | undefined {
  if (ts === undefined) return undefined;
  if (typeof ts === "number") return ts;
  const n = Number(ts);
  return Number.isFinite(n) ? n : undefined;
}

export function runtimeEntryToOutlineEntry(entry: RuntimeSessionEntry): OutlineEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined;

  const baseTs = parseTimestamp(entry.timestamp ?? entry.message?.timestamp);
  const etype = entry.type;

  if (etype === "message" && entry.message) {
    const msg = entry.message;
    const role = msg.role;
    const content = msg.content;

    if (role === "user") {
      const text = extractTextFromContent(content).trim();
      if (!text) return undefined;
      return { kind: "message", role: "user", timestamp: baseTs, text, toolCalls: [] };
    }

    if (role === "assistant") {
      const text = extractTextFromContent(content).trim();
      const toolCalls = extractAssistantToolCalls(content);
      if (!text && toolCalls.length === 0) return undefined;
      return { kind: "message", role: "assistant", timestamp: baseTs, text, toolCalls };
    }

    if (role === "toolResult") {
      const toolName = entry.toolName || entry.name || "tool";
      const text = extractTextFromContent(content).trim();
      const isError = !!entry.isError;
      const summary = formatToolResultSummary(toolName, text, isError, DEFAULT_OUTLINE_OPTIONS.maxToolResultChars);
      return { kind: "toolResult", toolName, timestamp: baseTs, isError, summary };
    }

    return undefined;
  }

  if (etype === "toolResult" || etype === "tool_result") {
    const toolName = entry.toolName || entry.name || "tool";
    const text = extractTextFromContent(entry.content).trim();
    const isError = !!entry.isError;
    const summary = formatToolResultSummary(toolName, text, isError, DEFAULT_OUTLINE_OPTIONS.maxToolResultChars);
    return { kind: "toolResult", toolName, timestamp: baseTs, isError, summary };
  }

  if (etype === "bashExecution") {
    const result = entry.result || {};
    const cmd = entry.command || result.command || "";
    const summary = firstLine(cmd, 80);
    const isError = result.exitCode !== 0 && result.exitCode !== undefined && result.exitCode !== null;
    return { kind: "bash", timestamp: baseTs, command: cmd, summary, isError };
  }

  if (etype === "compaction" && typeof entry.summary === "string") {
    return { kind: "summary", subtype: "compaction", timestamp: baseTs, text: entry.summary };
  }

  if (etype === "branch_summary" && typeof entry.summary === "string") {
    return { kind: "summary", subtype: "branch", timestamp: baseTs, text: entry.summary };
  }

  if (etype === "custom" && typeof entry.customType === "string") {
    const text = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {});
    return { kind: "custom", customType: entry.customType, timestamp: baseTs, text };
  }

  if (etype === "custom_message") {
    const customType = entry.customType || "unknown";
    const text = extractTextFromContent(entry.content).trim();
    if (!text) return undefined;
    return { kind: "custom", customType, timestamp: baseTs, text };
  }

  return undefined;
}

export function runtimeEntriesToOutlineEntries(entries: RuntimeSessionEntry[]): OutlineEntry[] {
  return entries.map(runtimeEntryToOutlineEntry).filter((e): e is OutlineEntry => e !== undefined);
}
