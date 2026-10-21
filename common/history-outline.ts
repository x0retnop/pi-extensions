/**
 * Shared session-history outline formatter.
 *
 * Converts raw Pi session entries into a compact, continuation-friendly markdown
 * outline that preserves full user/assistant dialogue while compressing tool
 * interactions.
 *
 * Two detail modes:
 * - handoff (default): short action one-liners + standalone tool-result first lines
 * - analytical export: full tool args, results as status only, custom meta dropped,
 *   tool results attached to the preceding assistant turn with [n] pairing
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

export interface OutlineToolCall {
  name: string;
  /** One-line description for handoff / short mode. */
  summary: string;
  /** Full arguments for analytical export (actionDetail=full). */
  args?: Record<string, unknown>;
  id?: string;
}

export interface OutlineAttachedResult {
  toolName: string;
  isError: boolean;
  /** Short error one-liner only; never full tool body. */
  errorHint?: string;
}

export interface OutlineMessageEntry {
  kind: "message";
  role: "user" | "assistant";
  timestamp?: number;
  text: string;
  toolCalls: OutlineToolCall[];
  thinking?: string;
  /** Tool results attached to this assistant turn (analytical grouping). */
  results?: OutlineAttachedResult[];
}

export interface OutlineToolResultEntry {
  kind: "toolResult";
  toolName: string;
  timestamp?: number;
  isError: boolean;
  summary: string;
  errorHint?: string;
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

export type ActionDetail = "short" | "full";
export type ToolResultMode = "summary" | "status" | "none";

export interface FormatOutlineOptions {
  /** Hard character cap for the returned markdown. Entire entries are dropped from the
   *  middle when the limit is exceeded, never partial entries. */
  maxChars?: number;
  /** Maximum characters to keep from a single tool result summary (summary mode). */
  maxToolResultChars?: number;
  /** Include timestamps in headers. */
  includeTimestamps?: boolean;
  /** Include a compact legend at the top. */
  includeLegend?: boolean;
  /**
   * When true, assistant turns emit full model reasoning under ### Reasoning
   * and final text under ### Reply (LLM-friendly sectioned outline).
   * When false (default), reasoning is silently omitted — no placeholder note.
   */
  includeThinking?: boolean;
  /**
   * short — one-line action summaries (handoff default).
   * full — tool name + full arguments (analytical export).
   */
  actionDetail?: ActionDetail;
  /**
   * summary — standalone ## ✅ tool: first-line body (handoff default).
   * status — ✅/❌ toolName only; prefer ### Results on assistant when attached.
   * none — drop tool results entirely.
   */
  toolResultMode?: ToolResultMode;
  /** Emit custom entries (tool-timestamp, role-switcher, …). Default true for handoff. */
  includeCustom?: boolean;
  /** Cap per argument value when actionDetail=full. */
  maxArgChars?: number;
}

export const DEFAULT_OUTLINE_OPTIONS: Required<FormatOutlineOptions> = {
  maxChars: 65_000,
  maxToolResultChars: 240,
  includeTimestamps: true,
  includeLegend: true,
  includeThinking: false,
  actionDetail: "short",
  toolResultMode: "summary",
  includeCustom: true,
  maxArgChars: 4_000,
};

/** Preset for session-memory outline / outline-reasoning Markdown export. */
export const ANALYTICAL_OUTLINE_OPTIONS: FormatOutlineOptions = {
  maxChars: Number.MAX_SAFE_INTEGER,
  includeTimestamps: true,
  includeLegend: false,
  actionDetail: "full",
  toolResultMode: "status",
  includeCustom: false,
  maxArgChars: 4_000,
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

/** Join non-redacted thinking blocks from assistant message content. */
export function extractThinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "thinking") continue;
    if (block.redacted) {
      out.push("[redacted thinking]");
      continue;
    }
    if (typeof block.thinking === "string" && block.thinking.trim()) {
      out.push(block.thinking.trim());
    }
  }
  return out.join("\n\n");
}

export function extractToolCallsFromContent(
  content: unknown,
): Array<{ name: string; arguments?: Record<string, any>; id?: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; arguments?: Record<string, any>; id?: string }> = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") {
      out.push({
        name: block.name,
        arguments: block.arguments,
        id: typeof block.id === "string" ? block.id : undefined,
      });
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
  if ((name === "grep" || name === "rg") && (a.path || a.pattern)) {
    return `grep ${a.pattern || ""} ${a.path || ""}`.trim();
  }
  if (name === "bash" || name === "pwsh" || name === "py") {
    const cmd = a.command || a.code || "";
    if (typeof cmd !== "string" || !cmd) return name;
    const heredocMatch = cmd.match(/cat\s*<<\s*['"]?\w+['"]?[\s\S]*?>\s*(\S+)/);
    if (heredocMatch) return `${name} heredoc → ${heredocMatch[1]}`;
    const firstWord = cmd.trim().split(/\s+/)[0] || name;
    return `${name}: ${firstWord}${cmd.trim().length > firstWord.length ? " …" : ""}`;
  }
  if (name === "web_search" || name === "code_search") {
    const q = a.query || a.q || "";
    if (typeof q === "string" && q) return `${name} ${q.slice(0, 60)}${q.length > 60 ? "…" : ""}`;
  }
  if (name === "fetch_content" || name === "web_fetch") {
    const url = a.url || a.uri || "";
    if (typeof url === "string" && url) return `${name} ${url.slice(0, 80)}${url.length > 80 ? "…" : ""}`;
  }
  const preferred = ["path", "file_path", "command", "code", "query", "url", "pattern", "target"];
  const key = preferred.find((k) => a[k] !== undefined) || Object.keys(a).find((k) => a[k] !== undefined);
  if (!key) return name;
  const val = a[key];
  const preview =
    typeof val === "string" ? val.slice(0, 60) : JSON.stringify(val).slice(0, 60);
  const suffix =
    (typeof val === "string" && val.length > 60) || JSON.stringify(val).length > 60 ? "…" : "";
  return `${name} ${key}=${preview}${suffix}`;
}

function clipArgValue(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  if (typeof value === "string") {
    if (value.length <= maxChars) return { text: value, truncated: false };
    return { text: value.slice(0, maxChars), truncated: true };
  }
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    json = String(value);
  }
  if (json.length <= maxChars) return { text: json, truncated: false };
  return { text: json.slice(0, maxChars), truncated: true };
}

/** Render one full tool call with numbered index and all arguments. */
export function formatFullToolCallLines(
  index: number,
  call: OutlineToolCall,
  maxArgChars: number,
): string[] {
  const lines = [`- [${index}] ${call.name}`];
  const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
  const keys = Object.keys(args);
  if (keys.length === 0) return lines;

  for (const key of keys) {
    const raw = args[key];
    if (raw === undefined) continue;
    const { text, truncated } = clipArgValue(raw, maxArgChars);
    const multiline = text.includes("\n") || text.length > 100;
    if (multiline) {
      lines.push(`  ${key}:`);
      for (const line of text.split("\n")) lines.push(`    ${line}`);
      if (truncated) lines.push("    …[truncated]");
    } else {
      lines.push(`  ${key}: ${text}${truncated ? "…[truncated]" : ""}`);
    }
  }
  return lines;
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

function renderActionLines(
  toolCalls: OutlineToolCall[],
  options: Required<FormatOutlineOptions>,
  numbered: boolean,
): string[] {
  const lines: string[] = [];
  if (options.actionDetail === "full") {
    toolCalls.forEach((t, i) => {
      lines.push(...formatFullToolCallLines(i + 1, t, options.maxArgChars));
    });
    return lines;
  }
  toolCalls.forEach((t, i) => {
    lines.push(numbered ? `- [${i + 1}] ${t.summary}` : `- ${t.summary}`);
  });
  return lines;
}

function renderAttachedResults(results: OutlineAttachedResult[]): string[] {
  const lines: string[] = ["### Results"];
  results.forEach((r, i) => {
    const status = r.isError ? "❌" : "✅";
    const hint = r.isError && r.errorHint ? ` — ${r.errorHint}` : "";
    lines.push(`- [${i + 1}] ${status} ${r.toolName}${hint}`);
  });
  return lines;
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

      const thinking = entry.thinking?.trim() || "";
      const text = entry.text?.trim() || "";
      const hasTools = entry.toolCalls.length > 0;
      const hasResults = (entry.results?.length ?? 0) > 0;
      const sectioned =
        options.includeThinking &&
        entry.role === "assistant" &&
        (thinking || text || hasTools || hasResults);

      if (sectioned) {
        if (thinking) {
          lines.push("### Reasoning");
          lines.push("");
          lines.push(thinking);
          if (text || hasTools || hasResults) lines.push("");
        }
        if (text) {
          lines.push("### Reply");
          lines.push("");
          lines.push(text);
          if (hasTools || hasResults) lines.push("");
        }
        if (hasTools) {
          lines.push("### Actions");
          lines.push(...renderActionLines(entry.toolCalls, options, true));
          if (hasResults) lines.push("");
        }
        if (hasResults && options.toolResultMode !== "none") {
          lines.push(...renderAttachedResults(entry.results!));
        }
      } else {
        // Default outline / handoff: full reply text, silent omit of reasoning.
        if (text) lines.push(text);
        if (hasTools) {
          if (text) lines.push("");
          if (options.actionDetail === "full" || hasResults) {
            lines.push("### Actions");
            lines.push(...renderActionLines(entry.toolCalls, options, true));
          } else {
            lines.push("**Actions:**");
            lines.push(...renderActionLines(entry.toolCalls, options, false));
          }
          if (hasResults && options.toolResultMode !== "none") {
            lines.push("");
            lines.push(...renderAttachedResults(entry.results!));
          }
        } else if (hasResults && options.toolResultMode !== "none") {
          if (text) lines.push("");
          lines.push(...renderAttachedResults(entry.results!));
        }
      }
      // Drop empty assistant shells (e.g. no text/tools and thinking omitted).
      if (lines.length <= 2) return "";
      return lines.join("\n");
    }
    case "toolResult": {
      if (options.toolResultMode === "none") return "";
      if (options.toolResultMode === "status") {
        const status = entry.isError ? "❌" : "✅";
        const hint = entry.isError && entry.errorHint ? ` — ${entry.errorHint}` : "";
        return `## ${status} ${entry.toolName}${hint}${tsSuffix}`;
      }
      return `## ${entry.summary}${tsSuffix}`;
    }
    case "bash": {
      if (options.toolResultMode === "none") return "";
      const status = entry.isError ? "❌" : "✅";
      if (options.toolResultMode === "status") {
        return `## ${status} bash${tsSuffix}`;
      }
      return `## ${status} bash: ${entry.summary}${tsSuffix}`;
    }
    case "summary": {
      const label = entry.subtype === "compaction" ? "Context compaction" : "Branch summary";
      const lines: string[] = [`## ${label}${tsSuffix}`, ""];
      lines.push(entry.text);
      return lines.join("\n");
    }
    case "custom": {
      if (!options.includeCustom) return "";
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
    ? opts.toolResultMode === "status"
      ? "_Legend: ✅ success / ❌ error. Actions show full call args; tool output bodies omitted._\n\n---\n\n"
      : "_Legend: ✅ success / ❌ error. Tool results are compressed to status + first line; open the session in the /sw browser or export it to read full details._\n\n---\n\n"
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
      `## [${skipped} intermediate entries omitted]\n\nFull session is available via the Pi session file or the /sw browser.\n\n---\n\n`,
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
    /** Present on toolResult messages in real Pi session JSONL. */
    toolName?: string;
    name?: string;
    toolCallId?: string;
    isError?: boolean;
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

export interface RuntimeToOutlineOptions {
  /**
   * Attach following toolResult entries onto the preceding assistant turn as
   * ### Results (analytical export). Default false (handoff keeps them separate).
   */
  attachResultsToAssistant?: boolean;
  /** Drop custom entries during conversion. Default false. */
  dropCustom?: boolean;
}

function extractAssistantToolCalls(content: unknown): OutlineToolCall[] {
  const calls = extractToolCallsFromContent(content);
  return calls.map((c) => ({
    name: c.name,
    summary: shortToolDescription(c.name, c.arguments),
    args: c.arguments && typeof c.arguments === "object" ? (c.arguments as Record<string, unknown>) : undefined,
    id: c.id,
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
      const thinking = extractThinkingFromContent(content);
      // Keep thinking-only turns so outline-reasoning can surface them; default
      // render still drops empty shells when includeThinking is false.
      if (!text && toolCalls.length === 0 && !thinking) return undefined;
      return {
        kind: "message",
        role: "assistant",
        timestamp: baseTs,
        text,
        toolCalls,
        thinking: thinking || undefined,
        results: [],
      };
    }

    if (role === "toolResult") {
      // Real Pi JSONL stores toolName/isError on message, not the top-level entry.
      const toolName = msg.toolName || msg.name || entry.toolName || entry.name || "tool";
      const text = extractTextFromContent(content).trim();
      const isError = !!(msg.isError ?? entry.isError);
      const summary = formatToolResultSummary(toolName, text, isError, DEFAULT_OUTLINE_OPTIONS.maxToolResultChars);
      const errorHint = isError ? firstLine(text, 200) || undefined : undefined;
      return { kind: "toolResult", toolName, timestamp: baseTs, isError, summary, errorHint };
    }

    return undefined;
  }

  if (etype === "toolResult" || etype === "tool_result") {
    const toolName = entry.toolName || entry.name || entry.message?.toolName || entry.message?.name || "tool";
    const text = extractTextFromContent(entry.content ?? entry.message?.content).trim();
    const isError = !!(entry.isError ?? entry.message?.isError);
    const summary = formatToolResultSummary(toolName, text, isError, DEFAULT_OUTLINE_OPTIONS.maxToolResultChars);
    const errorHint = isError ? firstLine(text, 200) || undefined : undefined;
    return { kind: "toolResult", toolName, timestamp: baseTs, isError, summary, errorHint };
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

/**
 * Convert runtime entries to outline entries.
 * When attachResultsToAssistant is set, tool results become ### Results on the
 * preceding assistant turn (for analytical export pairing).
 */
export function runtimeEntriesToOutlineEntries(
  entries: RuntimeSessionEntry[],
  options: RuntimeToOutlineOptions = {},
): OutlineEntry[] {
  const attach = !!options.attachResultsToAssistant;
  const dropCustom = !!options.dropCustom;
  const out: OutlineEntry[] = [];
  let pending: OutlineMessageEntry | null = null;

  const flushPending = () => {
    if (!pending) return;
    if (pending.results && pending.results.length === 0) delete pending.results;
    out.push(pending);
    pending = null;
  };

  for (const raw of entries) {
    const e = runtimeEntryToOutlineEntry(raw);
    if (!e) continue;
    if (dropCustom && e.kind === "custom") continue;

    if (e.kind === "message" && e.role === "assistant") {
      flushPending();
      pending = { ...e, results: [] };
      continue;
    }

    if (attach && e.kind === "toolResult" && pending) {
      pending.results = pending.results || [];
      pending.results.push({
        toolName: e.toolName,
        isError: e.isError,
        errorHint: e.errorHint,
      });
      continue;
    }

    if (attach && e.kind === "bash" && pending) {
      // User bash executions between assistant turns — keep separate.
      flushPending();
      out.push(e);
      continue;
    }

    flushPending();
    out.push(e);
  }
  flushPending();
  return out;
}
