import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { extractProject } from "./project.js";

export type ExportFormat = "chat" | "outline" | "full";

export interface LocalSessionItem {
  source_path: string;
  project: string;
  date: string;
  mtime: number;
  preview?: string;
}

export interface ProjectGroup {
  project: string;
  dir: string;
  sessions: LocalSessionItem[];
}

interface ParsedLine {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  content?: any;
  text?: string;
  summary?: string;
  type?: string;
}

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MB safety cap for a single session file
const MAX_OUTPUT_CHARS = 500_000; // hard cap for generated markdown

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

function slugifyTitle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function makeExportFileName(sourcePath: string, format: ExportFormat): string {
  const preview = extractUserPreview(sourcePath);
  const slug = slugifyTitle(preview || path.basename(sourcePath, ".jsonl"));
  const date = datePrefixFromFilename(sourcePath);
  return `${date}_${slug}.${format}.md`;
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

function scanSessions(dir: string, out: { mtime: number; path: string }[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanSessions(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(full);
        if (stat.size <= MAX_FILE_BYTES) {
          out.push({ mtime: stat.mtimeMs, path: full });
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
}

function extractUserPreview(sourcePath: string): string {
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
        return clean.slice(0, 60) + (clean.length > 60 ? "…" : "");
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return "";
}

export function listLocalSessions(limit = 100): LocalSessionItem[] {
  const items: LocalSessionItem[] = [];
  if (!fs.existsSync(SESSIONS_DIR)) return items;

  const files: { mtime: number; path: string }[] = [];
  scanSessions(SESSIONS_DIR, files);

  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, limit)) {
    items.push({
      source_path: f.path,
      project: extractProject(f.path),
      date: isoFromFilename(f.path),
      mtime: f.mtime,
      preview: extractUserPreview(f.path),
    });
  }
  return items;
}

export function groupSessionsByProject(limitPerProject = 50): ProjectGroup[] {
  const sessions = listLocalSessions(1000);
  const map = new Map<string, LocalSessionItem[]>();
  const dirMap = new Map<string, string>();

  for (const s of sessions) {
    const list = map.get(s.project) || [];
    list.push(s);
    map.set(s.project, list);
    if (!dirMap.has(s.project)) {
      dirMap.set(s.project, path.dirname(s.source_path));
    }
  }

  const groups: ProjectGroup[] = [];
  for (const [project, list] of map.entries()) {
    list.sort((a, b) => b.mtime - a.mtime);
    groups.push({
      project,
      dir: dirMap.get(project) || "",
      sessions: list.slice(0, limitPerProject),
    });
  }

  groups.sort((a, b) => b.sessions[0]?.mtime - a.sessions[0]?.mtime);
  return groups;
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
        role: m.role,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        isError: m.isError,
        timestamp: m.timestamp || obj.timestamp,
        content: m.content,
        text: typeof m.content === "string" ? m.content : undefined,
      };
    }
    if (etype === "compaction" && typeof obj.summary === "string") {
      return { role: "compactionSummary", summary: obj.summary, timestamp: obj.timestamp };
    }
    if (etype === "bashExecution" && obj.result) {
      return { role: "bash", content: obj.result, timestamp: obj.timestamp };
    }
    return undefined;
  } catch {
    return undefined;
  }
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

function extractToolCalls(content: any): Array<{ name: string; arguments?: any }> {
  if (!content || !Array.isArray(content)) return [];
  return content
    .filter((b: any) => b && typeof b === "object" && b.type === "toolCall" && typeof b.name === "string")
    .map((b: any) => ({ name: b.name, arguments: b.arguments }));
}

function extractThinking(content: any): string[] {
  if (!content || !Array.isArray(content)) return [];
  return content
    .filter((b: any) => b && typeof b === "object" && b.type === "thinking" && typeof b.thinking === "string")
    .map((b: any) => b.thinking);
}

function shortToolDescription(name: string, args: any): string {
  if (!args || typeof args !== "object") return name;
  const a = args;
  if (name === "read" && (a.path || a.file_path)) return `read ${a.path || a.file_path}`;
  if (name === "edit" && (a.path || a.file_path)) return `edit ${a.path || a.file_path}`;
  if (name === "grep" && (a.path || a.pattern)) return `grep ${a.pattern || ""} ${a.path || ""}`.trim();
  if (name === "bash") {
    const cmd = a.command || "";
    // Detect heredoc writes
    const heredocMatch = cmd.match(/cat\s*<<\s*['"]?\w+['"]?[\s\S]*?>\s*(\S+)/);
    if (heredocMatch) return `bash heredoc → ${heredocMatch[1]}`;
    // Detect python -c or python script.py
    const pyMatch = cmd.match(/python(?:3)?\s+(-c\s+['"][^'"]+['"]|\S+\.py)/);
    if (pyMatch) return `python ${pyMatch[1]}`;
    const firstWord = cmd.split(/\s+/)[0];
    return `bash: ${firstWord}${cmd.length > firstWord.length ? " …" : ""}`;
  }
  if (name === "write" && a.path) return `write ${a.path}`;
  const firstKey = Object.keys(a).find((k) => a[k] !== undefined);
  if (!firstKey) return name;
  const val = a[firstKey];
  const preview = typeof val === "string" ? val.slice(0, 40) : JSON.stringify(val).slice(0, 40);
  return `${name} ${firstKey}=${preview}${(typeof val === "string" && val.length > 40) || JSON.stringify(val).length > 40 ? "…" : ""}`;
}

function formatToolResultSummary(toolName: string, text: string, isError: boolean): string {
  const status = isError ? "❌" : "✅";
  const first = text.trim().split(/\r?\n/)[0] || "";
  const preview = first.slice(0, 80) + (first.length > 80 ? "…" : "");
  return `${status} ${toolName}${preview ? `: ${preview}` : ""}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  if (format === "outline") {
    const ts = formatDate(entry.timestamp);
    const timeLine = ts ? `*${ts}*` : "";
    if (entry.role === "user") {
      const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
      if (!text.trim()) return "";
      return `## User${timeLine ? " — " + timeLine : ""}\n\n${text.trim()}`;
    }
    if (entry.role === "assistant") {
      const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
      const tools = extractToolCalls(entry.content);
      const lines: string[] = [];
      if (text.trim()) lines.push(text.trim());
      if (tools.length) {
        lines.push("");
        lines.push("**Actions:**");
        for (const t of tools) lines.push(`- ${shortToolDescription(t.name, t.arguments)}`);
      }
      if (!lines.length) return "";
      return `## Assistant${timeLine ? " — " + timeLine : ""}\n\n${lines.join("\n")}`;
    }
    if (entry.role === "toolResult") {
      const text = entry.text || extractTextBlocks(entry.content).join("\n");
      const summary = formatToolResultSummary(entry.toolName || "tool", text, !!entry.isError);
      return `## ${summary}${timeLine ? " — " + timeLine : ""}`;
    }
    if (entry.role === "bash") {
      const cmd = entry.content?.command || "";
      const firstWord = cmd.split(/\s+/)[0];
      return `## bash: ${firstWord}${cmd.length > firstWord.length ? " …" : ""}${timeLine ? " — " + timeLine : ""}`;
    }
    if (entry.role === "compactionSummary") {
      return `## [context summary]`;
    }
    return "";
  }

  // format === "full"
  const ts = formatDate(entry.timestamp);
  const timeLine = ts ? `*${ts}*` : "";

  if (entry.role === "user") {
    const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
    if (!text.trim()) return "";
    return `## User${timeLine ? " — " + timeLine : ""}\n\n${text.trim()}`;
  }

  if (entry.role === "assistant") {
    const text = entry.text || extractTextBlocks(entry.content).join("\n\n");
    const thinking = extractThinking(entry.content);
    const tools = extractToolCalls(entry.content);
    const parts: string[] = [];
    if (text.trim()) parts.push(text.trim());
    if (thinking.length) {
      parts.push("");
      parts.push("<details>\n<summary>Thinking</summary>\n\n```text\n" + thinking.join("\n\n") + "\n```\n\n</details>");
    }
    if (tools.length) {
      parts.push("");
      parts.push("**Tool calls:**");
      for (const t of tools) {
        parts.push(`- **${t.name}**`);
        try {
          const args = JSON.stringify(t.arguments || {}, null, 2);
          parts.push("  ```json\n  " + args.split("\n").join("\n  ") + "\n  ```");
        } catch {
          parts.push(`  \`${String(t.arguments)}\``);
        }
      }
    }
    if (!parts.length) return "";
    return `## Assistant${timeLine ? " — " + timeLine : ""}\n\n${parts.join("\n")}`;
  }

  if (entry.role === "toolResult") {
    const text = entry.text || extractTextBlocks(entry.content).join("\n");
    const status = entry.isError ? "❌ Error" : "✅ Success";
    const header = `## Tool result — ${entry.toolName || "tool"} (${status})${timeLine ? " — " + timeLine : ""}`;
    if (!text.trim()) return header;
    let body = text.trim();
    // Wrap large results in collapsible block
    if (body.length > 2000) {
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

  return "";
}

export async function openSessionExportTUI(ui: any, groups: ProjectGroup[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let projectIndex = 0;
    let sessionIndex = 0;
    let mode: "project" | "session" = "project";
    let selectedProject: ProjectGroup | undefined;

    ui.custom((tui: TUI, theme: any, _kb: any, done: () => void) => {
      function render(width: number): string[] {
        const lines: string[] = [];
        if (mode === "project") {
          lines.push(truncateToWidth(theme.fg("accent", theme.bold("Export session > Select project")), width));
          lines.push("");
          if (groups.length === 0) {
            lines.push(theme.fg("dim", "  No sessions found."));
          } else {
            const maxVisible = 16;
            const start = Math.max(0, Math.min(projectIndex - Math.floor(maxVisible / 2), groups.length - maxVisible));
            const end = Math.min(start + maxVisible, groups.length);
            for (let i = start; i < end; i++) {
              const g = groups[i];
              const selected = i === projectIndex;
              const prefix = selected ? theme.fg("accent", "> ") : "  ";
              const name = selected ? theme.fg("accent", g.project) : theme.fg("text", g.project);
              const meta = theme.fg("dim", `${g.sessions.length} session${g.sessions.length === 1 ? "" : "s"}`);
              const date = g.sessions[0]?.date ? g.sessions[0].date.replace("T", " ").slice(0, 19) : "unknown";
              lines.push(truncateToWidth(`${prefix}${name} ${meta} · latest ${date}`, width));
            }
            if (start > 0 || end < groups.length) {
              lines.push(theme.fg("dim", `  (${projectIndex + 1}/${groups.length})`));
            }
          }
          lines.push("");
          lines.push(truncateToWidth(theme.fg("dim", "↑↓ move · Enter select project · Esc cancel"), width));
        } else {
          const sessions = selectedProject!.sessions;
          lines.push(truncateToWidth(theme.fg("accent", theme.bold(`Export session > ${selectedProject!.project}`)), width));
          lines.push("");
          const maxVisible = 16;
          const start = Math.max(0, Math.min(sessionIndex - Math.floor(maxVisible / 2), sessions.length - maxVisible));
          const end = Math.min(start + maxVisible, sessions.length);
          for (let i = start; i < end; i++) {
            const s = sessions[i];
            const selected = i === sessionIndex;
            const prefix = selected ? theme.fg("accent", "> ") : "  ";
            const date = s.date ? s.date.replace("T", " ").slice(0, 19) : "unknown";
            const preview = s.preview ? ` — ${s.preview}` : "";
            const label = `${date}${preview}`;
            const line = selected ? theme.fg("accent", label) : theme.fg("text", label);
            lines.push(truncateToWidth(`${prefix}${line}`, width));
          }
          if (start > 0 || end < sessions.length) {
            lines.push(theme.fg("dim", `  (${sessionIndex + 1}/${sessions.length})`));
          }
          lines.push("");
          lines.push(truncateToWidth(theme.fg("dim", "↑↓ move · Enter select session · Esc back"), width));
        }
        return lines;
      }

      function handleInput(data: string): void {
        const kb = getKeybindings();
        if (mode === "project") {
          if (groups.length === 0) {
            if (kb.matches(data, "tui.select.cancel") || data === "q") {
              done();
              resolve(undefined);
            }
            tui.requestRender();
            return;
          }
          if (kb.matches(data, "tui.select.up")) {
            projectIndex = projectIndex === 0 ? groups.length - 1 : projectIndex - 1;
          } else if (kb.matches(data, "tui.select.down")) {
            projectIndex = projectIndex === groups.length - 1 ? 0 : projectIndex + 1;
          } else if (kb.matches(data, "tui.select.confirm")) {
            selectedProject = groups[projectIndex];
            sessionIndex = 0;
            mode = "session";
          } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
            done();
            resolve(undefined);
          }
        } else {
          const sessions = selectedProject!.sessions;
          if (kb.matches(data, "tui.select.up")) {
            sessionIndex = sessionIndex === 0 ? sessions.length - 1 : sessionIndex - 1;
          } else if (kb.matches(data, "tui.select.down")) {
            sessionIndex = sessionIndex === sessions.length - 1 ? 0 : sessionIndex + 1;
          } else if (kb.matches(data, "tui.select.confirm")) {
            const sourcePath = sessions[sessionIndex]?.source_path;
            done();
            resolve(sourcePath);
            return;
          } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
            mode = "project";
            sessionIndex = 0;
          }
        }
        tui.requestRender();
      }

      return {
        render,
        handleInput,
        invalidate() {},
      };
    });
  });
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

  const project = extractProject(sourcePath);
  const date = isoFromFilename(sourcePath) || formatDate(Date.now());
  const outName = makeExportFileName(sourcePath, format);
  const outPath = path.join(cwd, outName);

  const headerLines = [
    `# Pi session export`,
    "",
    `- **Format:** ${format}`,
    `- **Date:** ${date}`,
    `- **Project:** ${project}`,
    `- **Source:** \`${sourcePath}\``,
    "",
    "---",
    "",
  ];

  const chunks: string[] = [headerLines.join("\n")];
  let entries = 0;
  let totalChars = chunks[0].length;

  try {
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
      if (totalChars + block.length > MAX_OUTPUT_CHARS) {
        chunks.push(`\n\n_[Export truncated at ${MAX_OUTPUT_CHARS} chars]_\n`);
        totalChars += chunks[chunks.length - 1].length;
        break;
      }
      chunks.push(block);
      totalChars += block.length;
      entries++;
    }
    // drain remaining buffer
    if (buffer.trim() && totalChars < MAX_OUTPUT_CHARS) {
      const entry = parseJsonlLine(buffer);
      if (entry) {
        const rendered = buildEntryForFormat(entry, format);
        if (rendered) {
          const block = rendered + "\n\n---\n\n";
          if (totalChars + block.length <= MAX_OUTPUT_CHARS) {
            chunks.push(block);
            entries++;
          }
        }
      }
    }
  } catch (err) {
    return { ok: false, error: `Error reading session: ${err instanceof Error ? err.message : String(err)}` };
  }

  const finalText = chunks.join("");
  try {
    fs.writeFileSync(outPath, finalText, "utf-8");
  } catch (err) {
    return { ok: false, error: `Error writing output: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ok: true, path: outPath, entries, chars: finalText.length };
}
