import fs from "node:fs";
import path from "node:path";
import {
  ANALYTICAL_OUTLINE_OPTIONS,
  formatHistoryOutline,
  runtimeEntriesToOutlineEntries,
  type RuntimeSessionEntry,
} from "../common/history-outline.js";
import { extractProjectFromSessionFile } from "./project.js";

/** chat / outline / full keep previous semantics; outline-reasoning / reasoning / real-full are additive. */
export type ExportFormat = "chat" | "outline" | "outline-reasoning" | "full" | "reasoning" | "real-full";

// NOTE: session listing/picking lives in local-sessions.ts + session-browser.ts.
// This module only parses and renders a chosen session file to Markdown.

interface ParsedLine {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number | string;
  content?: any;
  text?: string;
  summary?: string;
  type?: string;
  customType?: string;
  data?: unknown;
  meta?: Record<string, unknown>;
  /** Original parsed JSONL object, kept for the shared outline formatter which
   *  expects the runtime entry shape ({type, message, ...}). */
  raw?: RuntimeSessionEntry;
}

const MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MB safety cap for a single session file
const MAX_OUTPUT_CHARS = 500_000; // hard cap for generated markdown (standard formats)
const MAX_OUTPUT_CHARS_REAL_FULL = 5_000_000; // higher cap for real-full dumps
const COLLAPSE_TOOL_RESULT_CHARS = 2000;

function isoFromFilename(sourcePath: string): string {
  const name = path.basename(sourcePath, ".jsonl");
  if (name.length >= 19 && name[4] === "-" && name[7] === "-") {
    return name.slice(0, 10) + "T" + name.slice(11, 13) + ":" + name.slice(14, 16) + ":" + name.slice(17, 19);
  }
  return "";
}

function datePrefixFromFilename(sourcePath: string): string {
  const name = path.basename(sourcePath, ".jsonl");
  if (name.length >= 10 && name[4] === "-" && name[7] === "-") {
    return name.slice(0, 10);
  }
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `HHmm` from session filename `YYYY-MM-DDTHH-MM-SS-...`. */
function timePrefixFromFilename(sourcePath: string): string {
  const name = path.basename(sourcePath, ".jsonl");
  // 2026-08-03T07-22-19-797Z_...
  if (name.length >= 16 && name[10] === "T" && name[13] === "-" && name[16] === "-") {
    return name.slice(11, 13) + name.slice(14, 16);
  }
  return "";
}

/** First 8 hex chars of session uuid (stable, unique enough in a folder). */
function sessionShortId(sourcePath: string): string {
  const name = path.basename(sourcePath, ".jsonl");
  const parts = name.split("_");
  const idPart = parts.length >= 2 ? parts[parts.length - 1] : name;
  const hex = idPart.replace(/[^a-fA-F0-9]/g, "");
  if (hex.length >= 8) return hex.slice(0, 8).toLowerCase();
  const fallback = name.replace(/[^a-zA-Z0-9]/g, "");
  return (fallback.slice(0, 8) || "session").toLowerCase();
}

/**
 * Readable filesystem slug. Keeps unicode letters (Cyrillic etc.) so topic
 * text is not wiped — the old /\w/ path left only path crumbs from Windows paths.
 */
export function slugifyTitle(name: string, maxLen = 40): string {
  const s = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]+/gu, " ")
    .replace(/[._]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (s.length <= maxLen) return s;
  // Prefer cutting on a hyphen boundary.
  const cut = s.slice(0, maxLen);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen >= 12 ? cut.slice(0, lastHyphen) : cut).replace(/-$/g, "");
}

function projectLeafSlug(sourcePath: string): string {
  const project = extractProjectFromSessionFile(sourcePath);
  const leaf = project.split(/[/\\]/).filter(Boolean).pop() || "project";
  return slugifyTitle(leaf, 24) || "project";
}

/**
 * Short topic from first user message. Strips paths/URLs so
 * `C:\Users\...\Telegram.exe и хз где настройки` → `и-хз-где-настройки` (capped).
 */
function topicSlugFromUser(sourcePath: string): string {
  const raw = extractUserPreviewRaw(sourcePath, 160);
  if (!raw) return "";
  let t = raw
    // Windows paths (segments may contain spaces, e.g. "Telegram Desktop")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\s"'`\r\n]*/g, " ")
    .replace(/[A-Za-z]:\/(?:[^/\r\n]+\/)*[^\s"'`\r\n]*/g, " ")
    // Git-bash / POSIX-ish paths
    .replace(/\/(?:c|d|Users|home|tmp|var|mnt)\/[^\s"'`]+/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\b[\w.-]+\.(exe|dll|jsonl?|md|ts|js|py|txt|log)\b/gi, " ");
  const slug = slugifyTitle(t, 28);
  // Drop useless leftovers (too short, or still looks like a mashed path).
  if (slug.length < 3) return "";
  if (/^(c|d|users|user|appdata|roaming|local|temp|tmp|desktop)(-|$)/i.test(slug)) return "";
  return slug;
}

/**
 * Export filename — short, readable, unique:
 *   `{date}_{time}_{project}[_{topic}]_{id8}.{format}.md`
 * e.g. `2026-08-03_0722_example_nastrojki-telegram_e423e88d.outline-reasoning.md`
 */
export function makeExportFileName(sourcePath: string, format: ExportFormat): string {
  const date = datePrefixFromFilename(sourcePath);
  const time = timePrefixFromFilename(sourcePath);
  const project = projectLeafSlug(sourcePath);
  const topic = topicSlugFromUser(sourcePath);
  const id = sessionShortId(sourcePath);

  const parts = [date, time, project].filter((p) => !!p);
  if (topic) parts.push(topic);
  parts.push(id);
  return `${parts.join("_")}.${format}.md`;
}


/**
 * First user message text, whitespace-normalized.
 * @param maxChars cap length (no ellipsis added here)
 */
function extractUserPreviewRaw(sourcePath: string, maxChars = 160): string {
  try {
    const fd = fs.openSync(sourcePath, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024); // read first 16 KB
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.toString("utf-8", 0, bytesRead);
      let tail = head;
      let idx: number;
      while ((idx = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, idx + 1);
        tail = tail.slice(idx + 1);
        const entry = parseJsonlLine(line);
        if (entry?.role !== "user") continue;
        const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
        if (!text.trim()) continue;
        const clean = text.trim().replace(/\s+/g, " ");
        return clean.slice(0, maxChars);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return "";
}

function extractTextBlocks(content: any): string[] {
  if (!content) return [];
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      out.push(block.text);
    }
  }
  return out;
}

function extractThinkingBlocks(content: any): Array<{ thinking: string; redacted?: boolean }> {
  if (!content || !Array.isArray(content)) return [];
  const out: Array<{ thinking: string; redacted?: boolean }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "thinking") continue;
    if (block.redacted) {
      out.push({ thinking: "[redacted thinking]", redacted: true });
    } else if (typeof block.thinking === "string" && block.thinking.length > 0) {
      out.push({ thinking: block.thinking });
    }
  }
  return out;
}

function parseJsonlLine(raw: string): ParsedLine | undefined {
  const line = raw.trim();
  if (!line) return undefined;
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== "object") return undefined;

    const etype = obj.type;
    if (etype === "message" && obj.message && typeof obj.message === "object") {
      const m = obj.message;
      return {
        type: "message",
        role: m.role,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        isError: m.isError,
        timestamp: m.timestamp || obj.timestamp,
        content: m.content,
        text: typeof m.content === "string" ? m.content : undefined,
        raw: obj as RuntimeSessionEntry,
      };
    }
    if (etype === "compaction" && typeof obj.summary === "string") {
      return { type: "compaction", role: "compactionSummary", summary: obj.summary, timestamp: obj.timestamp, raw: obj as RuntimeSessionEntry };
    }
    if (etype === "bashExecution" && obj.result) {
      return { type: "bashExecution", role: "bash", content: obj.result, timestamp: obj.timestamp, raw: obj as RuntimeSessionEntry };
    }
    if (etype === "custom") {
      return {
        type: "custom",
        role: "custom",
        customType: typeof obj.customType === "string" ? obj.customType : "custom",
        data: obj.data,
        timestamp: obj.timestamp,
        raw: obj as RuntimeSessionEntry,
      };
    }
    if (etype === "model_change") {
      return {
        type: "model_change",
        role: "meta",
        timestamp: obj.timestamp,
        meta: { provider: obj.provider, modelId: obj.modelId },
        raw: obj as RuntimeSessionEntry,
      };
    }
    if (etype === "thinking_level_change") {
      return {
        type: "thinking_level_change",
        role: "meta",
        timestamp: obj.timestamp,
        meta: { thinkingLevel: obj.thinkingLevel },
        raw: obj as RuntimeSessionEntry,
      };
    }
    if (etype === "session") {
      return {
        type: "session",
        role: "meta",
        timestamp: obj.timestamp,
        meta: { id: obj.id, version: obj.version, cwd: obj.cwd },
        raw: obj as RuntimeSessionEntry,
      };
    }
    // Unknown entry types: only surface in real-full so nothing is silently dropped.
    if (etype && typeof etype === "string") {
      return {
        type: etype,
        role: "unknown",
        timestamp: obj.timestamp,
        data: obj,
        raw: obj as RuntimeSessionEntry,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function formatDate(ts: number | string | undefined): string {
  if (ts === undefined) return "";
  try {
    const num = typeof ts === "string" ? (ts.match(/^\d+$/) ? parseInt(ts, 10) : NaN) : ts;
    const d = typeof num === "number" && !Number.isNaN(num)
      ? new Date(num < 1e12 ? num * 1000 : num)
      : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(ts);
  }
}

interface RichFormatOptions {
  /** Include thinking/reasoning blocks with clear section markers. */
  includeThinking: boolean;
  /** Collapse tool results longer than COLLAPSE_TOOL_RESULT_CHARS into <details>. */
  collapseToolResults: boolean;
  /** Include custom / model / other meta session entries. */
  includeMeta: boolean;
  /** Dump unknown entry types as JSON. */
  includeUnknown: boolean;
}

function formatOptionsFor(format: ExportFormat): RichFormatOptions {
  switch (format) {
    case "reasoning":
      return { includeThinking: true, collapseToolResults: true, includeMeta: false, includeUnknown: false };
    case "real-full":
      return { includeThinking: true, collapseToolResults: false, includeMeta: true, includeUnknown: true };
    case "full":
    default:
      return { includeThinking: false, collapseToolResults: true, includeMeta: false, includeUnknown: false };
  }
}

function buildEntryForFormat(entry: ParsedLine, format: ExportFormat): string {
  if (format === "chat") {
    if (entry.role === "user" || entry.role === "assistant") {
      const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
      if (!text.trim()) return "";
      const label = entry.role === "user" ? "User" : "Assistant";
      return `## ${label}\n\n${text.trim()}`;
    }
    return "";
  }

  // outline / outline-reasoning are batch-rendered in exportSessionToMarkdown
  // (need attach-results grouping across entries).

  // full | reasoning | real-full
  return buildRichEntry(entry, formatOptionsFor(format));
}

/** Collect raw runtime entries from a session JSONL for analytical outline export. */
function collectRuntimeEntries(sourcePath: string): RuntimeSessionEntry[] {
  const data = fs.readFileSync(sourcePath, "utf-8");
  const out: RuntimeSessionEntry[] = [];
  let buffer = data;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    const entry = parseJsonlLine(line + "\n");
    if (entry?.raw) out.push(entry.raw);
  }
  if (buffer.trim()) {
    const entry = parseJsonlLine(buffer);
    if (entry?.raw) out.push(entry.raw);
  }
  return out;
}

function buildOutlineExportBody(sourcePath: string, format: "outline" | "outline-reasoning"): {
  body: string;
  entries: number;
} {
  const raws = collectRuntimeEntries(sourcePath);
  const outlineEntries = runtimeEntriesToOutlineEntries(raws, {
    attachResultsToAssistant: true,
    dropCustom: true,
  });
  const body = formatHistoryOutline(outlineEntries, {
    ...ANALYTICAL_OUTLINE_OPTIONS,
    includeThinking: format === "outline-reasoning",
  });
  // formatHistoryOutline already joins with ---; strip trailing separators for cleaner file end.
  const cleaned = body.replace(/(?:\n---\n\n?)+$/g, "\n").trimEnd() + "\n";
  return { body: cleaned, entries: outlineEntries.length };
}

function buildRichEntry(entry: ParsedLine, opts: RichFormatOptions): string {
  const ts = formatDate(entry.timestamp);
  const timeLine = ts ? `*${ts}*` : "";

  if (entry.role === "user") {
    const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
    if (!text.trim()) return "";
    return `## User${timeLine ? " — " + timeLine : ""}\n\n${text.trim()}`;
  }

  if (entry.role === "assistant") {
    const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
    const thinking = opts.includeThinking ? extractThinkingBlocks(entry.content) : [];
    const tools = extractToolCalls(entry.content);
    const parts: string[] = [];

    if (thinking.length > 0) {
      parts.push("### Reasoning");
      parts.push("");
      for (let i = 0; i < thinking.length; i++) {
        if (thinking.length > 1) {
          parts.push(`#### Reasoning block ${i + 1}`);
          parts.push("");
        }
        parts.push(thinking[i].thinking.trim());
        if (i < thinking.length - 1) parts.push("");
      }
      parts.push("");
      parts.push("---");
      parts.push("");
    }

    if (text.trim()) {
      if (thinking.length > 0) {
        parts.push("### Final answer");
        parts.push("");
      }
      parts.push(text.trim());
    }

    if (tools.length) {
      if (parts.length) parts.push("");
      parts.push(thinking.length > 0 || text.trim() ? "### Tool calls" : "**Tool calls:**");
      for (const t of tools) {
        const idSuffix = t.id ? ` \`${t.id}\`` : "";
        parts.push(`- **${t.name}**${idSuffix}`);
        try {
          const args = JSON.stringify(t.arguments || {}, null, 2);
          parts.push("  ```json\n  " + args.split("\n").join("\n  ") + "\n  ```");
        } catch {
          parts.push(`  \`${String(t.arguments)}\``);
        }
      }
    }

    // Reasoning-only assistant turn (no text, no tools) still worth exporting when thinking is requested.
    if (!parts.length) return "";
    return `## Assistant${timeLine ? " — " + timeLine : ""}\n\n${parts.join("\n")}`;
  }

  if (entry.role === "toolResult") {
    const text = entry.text || extractTextBlocks(entry.content).join("\n");
    const status = entry.isError ? "❌ Error" : "✅ Success";
    const idPart = entry.toolCallId ? ` · \`${entry.toolCallId}\`` : "";
    const header = `## Tool result — ${entry.toolName || "tool"} (${status})${idPart}${timeLine ? " — " + timeLine : ""}`;
    if (!text.trim()) return header;
    let body = text.trim();
    if (opts.collapseToolResults && body.length > COLLAPSE_TOOL_RESULT_CHARS) {
      body = `<details>\n<summary>Result (${body.length} chars)</summary>\n\n\`\`\`text\n${escapeMarkdown(body)}\n\`\`\`\n\n</details>`;
    } else {
      body = "```text\n" + escapeMarkdown(body) + "\n```";
    }
    return `${header}\n\n${body}`;
  }

  if (entry.role === "bash") {
    const cmd = entry.content?.command || "";
    const output = entry.content?.stdout || "";
    const stderr = entry.content?.stderr || "";
    const lines = [`## Bash${timeLine ? " — " + timeLine : ""}`];
    if (cmd) {
      lines.push("**Command:**");
      lines.push("```bash\n" + cmd + "\n```");
    }
    if (output || stderr) {
      lines.push("");
      lines.push("**Output:**");
      lines.push("```text\n" + escapeMarkdown(output + (stderr ? "\n[stderr]\n" + stderr : "")) + "\n```");
    }
    return lines.join("\n");
  }

  if (entry.role === "compactionSummary") {
    return `## Context summary${timeLine ? " — " + timeLine : ""}\n\n${entry.summary || ""}`;
  }

  if (opts.includeMeta && entry.role === "custom") {
    const payload = safeJson(entry.data);
    return `## Custom — ${entry.customType || "custom"}${timeLine ? " — " + timeLine : ""}\n\n\`\`\`json\n${payload}\n\`\`\``;
  }

  if (opts.includeMeta && entry.role === "meta") {
    const label =
      entry.type === "model_change"
        ? "Model change"
        : entry.type === "thinking_level_change"
          ? "Thinking level"
          : entry.type === "session"
            ? "Session header"
            : entry.type || "Meta";
    const payload = safeJson(entry.meta ?? entry.data ?? {});
    return `## ${label}${timeLine ? " — " + timeLine : ""}\n\n\`\`\`json\n${payload}\n\`\`\``;
  }

  if (opts.includeUnknown && entry.role === "unknown") {
    const payload = safeJson(entry.data ?? entry.raw ?? {});
    return `## Entry (${entry.type || "unknown"})${timeLine ? " — " + timeLine : ""}\n\n\`\`\`json\n${payload}\n\`\`\``;
  }

  return "";
}

function extractToolCalls(content: any): Array<{ name: string; arguments?: any; id?: string }> {
  if (!content || !Array.isArray(content)) return [];
  return content
    .filter((b: any) => b && typeof b === "object" && b.type === "toolCall" && typeof b.name === "string")
    .map((b: any) => ({ name: b.name, arguments: b.arguments, id: typeof b.id === "string" ? b.id : undefined }));
}

function escapeMarkdown(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

export function exportSessionToMarkdown(
  sourcePath: string,
  format: ExportFormat,
  cwd: string,
): { ok: true; path: string; entries: number; chars: number } | { ok: false; error: string } {
  try {
    const stat = fs.statSync(sourcePath);
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, error: `Session file is too large (${Math.round(stat.size / 1024 / 1024)} MB > 256 MB)` };
    }
  } catch (err) {
    return { ok: false, error: `Cannot stat session file: ${err instanceof Error ? err.message : String(err)}` };
  }

  const project = extractProjectFromSessionFile(sourcePath);
  const date = isoFromFilename(sourcePath) || formatDate(Date.now());
  const outName = makeExportFileName(sourcePath, format);
  const outPath = path.join(cwd, outName);
  const maxOutput = format === "real-full" ? MAX_OUTPUT_CHARS_REAL_FULL : MAX_OUTPUT_CHARS;

  const formatNote =
    format === "outline-reasoning"
      ? "analytical: full reasoning + full tool args; results status-only; no custom meta"
      : format === "outline"
        ? "analytical: full tool args; results status-only; reasoning omitted; no custom meta"
        : format === "reasoning"
          ? "full + complete reasoning (### Reasoning / ### Final answer)"
          : format === "real-full"
            ? "all messages, tool calls/results untruncated, meta entries included"
            : format === "full"
              ? "tools + results (reasoning omitted; large results collapsible)"
              : format;

  const headerLines = [
    `# Pi session export`,
    "",
    `- **Format:** ${format}`,
    `- **Format notes:** ${formatNote}`,
    `- **Date:** ${date}`,
    `- **Project:** ${project}`,
    `- **Source:** \`${sourcePath}\``,
    "",
    "---",
    "",
  ];

  let finalText: string;
  let entries = 0;

  try {
    if (format === "outline" || format === "outline-reasoning") {
      const { body, entries: n } = buildOutlineExportBody(sourcePath, format);
      entries = n;
      let bodyText = body;
      if (headerLines.join("\n").length + bodyText.length > maxOutput) {
        bodyText =
          bodyText.slice(0, Math.max(0, maxOutput - headerLines.join("\n").length - 80)) +
          `\n\n_[Export truncated at ${maxOutput} chars]_\n`;
      }
      finalText = headerLines.join("\n") + bodyText;
    } else {
      const chunks: string[] = [headerLines.join("\n")];
      let totalChars = chunks[0].length;
      const data = fs.readFileSync(sourcePath, "utf-8");
      let buffer = data;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        const entry = parseJsonlLine(line);
        if (!entry) continue;
        const rendered = buildEntryForFormat(entry, format);
        if (!rendered) continue;
        const block = rendered + "\n\n---\n\n";
        if (totalChars + block.length > maxOutput) {
          chunks.push(`\n\n_[Export truncated at ${maxOutput} chars]_\n`);
          totalChars += chunks[chunks.length - 1].length;
          break;
        }
        chunks.push(block);
        totalChars += block.length;
        entries++;
      }
      if (buffer.trim() && totalChars < maxOutput) {
        const entry = parseJsonlLine(buffer);
        if (entry) {
          const rendered = buildEntryForFormat(entry, format);
          if (rendered) {
            const block = rendered + "\n\n---\n\n";
            if (totalChars + block.length <= maxOutput) {
              chunks.push(block);
              entries++;
            }
          }
        }
      }
      finalText = chunks.join("");
    }
  } catch (err) {
    return { ok: false, error: `Error reading session: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    fs.writeFileSync(outPath, finalText, "utf-8");
  } catch (err) {
    return { ok: false, error: `Error writing output: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ok: true, path: outPath, entries, chars: finalText.length };
}
