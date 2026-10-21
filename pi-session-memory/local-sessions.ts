/**
 * Local (no-backend) session discovery for the human browser / /sw.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { extractProject, extractProjectFromSessionFile, normalizeProjectPath, readSessionCwd } from "./project.js";
import {
  newestNoteInLines,
  newestSessionInfoInLines,
  noteFromEntry,
  splitCompleteLines,
  type NoteHit,
  type SessionInfoHit,
} from "./session-note.js";

/** `/sw` list filter: this project, this session, or everything. */
export type SessionScope = "project" | "current" | "all";
/** Human `/sw` Tab cycle. `projects` is TUI-only (pick a cwd, then its sessions). */
export type BrowserScope = SessionScope | "projects";

export const BROWSER_SCOPE_ORDER: BrowserScope[] = ["project", "current", "projects", "all"];

export function nextSessionScope(scope: BrowserScope, opts?: { skipCurrent?: boolean }): BrowserScope {
  const order = opts?.skipCurrent
    ? BROWSER_SCOPE_ORDER.filter((s) => s !== "current")
    : BROWSER_SCOPE_ORDER;
  const i = order.indexOf(scope);
  return order[((i < 0 ? 0 : i) + 1) % order.length];
}

export function sessionScopeLabel(scope: BrowserScope): string {
  switch (scope) {
    case "project":
      return "Project tree";
    case "current":
      return "Current cwd";
    case "projects":
      return "By project";
    case "all":
      return "All projects";
  }
}

/** Generated annotation (title + summary) written to the session head; see session-note.ts. */
export interface SessionAnnotation {
  title: string;
  summary: string;
  at: string;
}

export interface LocalSessionMeta {
  source_path: string;
  project: string;
  cwd?: string;
  /** ISO-ish stamp from filename when present. */
  date: string;
  mtime: number;
  sizeBytes: number;
  /** Effective display name: newest of our annotation title and Pi's `session_info`. */
  name?: string;
  /** Best short title (name or first user). */
  title: string;
  /** Model-written navigation annotation, when the session has one. */
  annotation?: SessionAnnotation;
  firstUser?: string;
  /** Unique tool names seen in the head scan. */
  tools: string[];
  userMessages: number;
  assistantMessages: number;
  /** Message entries seen in the head scan (not full-file). */
  scannedMessages: number;
  scanTruncated: boolean;
}

/** One user/assistant message for the chat-style preview (head-only). */
export interface PreviewMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatPreview {
  source_path: string;
  project: string;
  date: string;
  meta: LocalSessionMeta;
  messages: PreviewMessage[];
  /** Set when the file could not be read. */
  note?: string;
}

const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
/** Skip monster files in list preview (same ballpark as export). */
const MAX_LIST_FILE_BYTES = 256 * 1024 * 1024;
const HEAD_SCAN_BYTES = 96 * 1024;
const HEAD_SCAN_LINES = 250;
/** Tail window: secondary look for a note/name newer than the head copy. */
const TAIL_SCAN_BYTES = 32 * 1024;
/** Chat preview: first N dialog messages, each capped (head scan only). */
const PREVIEW_MESSAGE_COUNT = 24;
const PREVIEW_MESSAGE_CHARS = 1200;

/** Pi encodes cwd as `--${cwd without leading slash, /\: → -}--` under sessions/. */
export function encodeSessionDirName(cwd: string): string {
  const resolved = path.resolve(cwd);
  const safe = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${safe}--`;
}

export function getSessionsRoot(override?: string): string {
  return override || DEFAULT_SESSIONS_DIR;
}

/**
 * Whether a sessions subdir name belongs to scope relative to cwd.
 * Uses Pi folder encoding (fast path). Does not open files.
 */
export function sessionDirMatchesScope(dirName: string, cwd: string, scope: SessionScope): boolean {
  if (scope === "all") return true;
  if (!dirName.startsWith("--") || !dirName.endsWith("--")) return false;
  const encoded = encodeSessionDirName(cwd);
  if (scope === "current") return dirName === encoded;
  // project tree: exact cwd dir + children encoded as prefix + "-" + rest
  if (dirName === encoded) return true;
  const childPrefix = encoded.slice(0, -2) + "-";
  return dirName.startsWith(childPrefix);
}

/**
 * True when Project tree would include a child cwd that Current cwd would not.
 * Used to skip the redundant Current cwd Tab stop at leaf projects.
 */
export function hasChildSessionDirs(cwd: string, sessionsDir?: string): boolean {
  const root = getSessionsRoot(sessionsDir);
  if (!fs.existsSync(root)) return false;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    if (!sessionDirMatchesScope(ent.name, cwd, "project")) continue;
    if (sessionDirMatchesScope(ent.name, cwd, "current")) continue;
    try {
      const files = fs.readdirSync(path.join(root, ent.name));
      if (files.some((f) => f.endsWith(".jsonl"))) return true;
    } catch {
      // unreadable dir
    }
  }
  return false;
}

function isoFromFilename(sourcePath: string): string {
  const name = path.basename(sourcePath, ".jsonl");
  if (name.length >= 19 && name[4] === "-" && name[7] === "-") {
    return name.slice(0, 10) + "T" + name.slice(11, 13) + ":" + name.slice(14, 16) + ":" + name.slice(17, 19);
  }
  return "";
}

function stampOf(value?: string): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Newest of two stamped hits; ties go to `b`. */
function newerOf<T extends { timestamp: string }>(a?: T, b?: T): T | undefined {
  if (!a) return b;
  if (!b) return a;
  return stampOf(b.timestamp) >= stampOf(a.timestamp) ? b : a;
}

function extractTextContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
      parts.push((block as any).text);
    }
  }
  return parts.join("\n");
}

function clip(text: string, limit: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit - 1) + "…";
}

/** Like clip but preserves real newlines — for chat preview message bodies. */
function clipText(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit - 1) + "…";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSizeLabel(bytes: number): string {
  return formatSize(bytes);
}

export function formatMtimeLabel(mtimeMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - mtimeMs);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const d = new Date(mtimeMs);
  const iso = d.toISOString().slice(0, 16).replace("T", " ");
  return iso;
}

interface HeadScan {
  cwd?: string;
  info?: SessionInfoHit;
  note?: NoteHit;
  firstUsers: string[];
  tools: string[];
  userMessages: number;
  assistantMessages: number;
  scannedMessages: number;
  firstAssistant?: string;
  /** Interleaved user/assistant dialog for the chat preview. */
  messages: PreviewMessage[];
  truncated: boolean;
}

function scanSessionHead(sourcePath: string): HeadScan {
  const out: HeadScan = {
    firstUsers: [],
    tools: [],
    userMessages: 0,
    assistantMessages: 0,
    scannedMessages: 0,
    messages: [],
    truncated: false,
  };
  const toolSet = new Set<string>();

  try {
    const fd = fs.openSync(sourcePath, "r");
    try {
      const buf = Buffer.alloc(HEAD_SCAN_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString("utf-8", 0, n);
      out.truncated = n >= HEAD_SCAN_BYTES;

      let rest = head;
      let lines = 0;
      while (lines < HEAD_SCAN_LINES) {
        const idx = rest.indexOf("\n");
        const raw = idx >= 0 ? rest.slice(0, idx) : rest;
        if (idx >= 0) rest = rest.slice(idx + 1);
        else rest = "";
        lines++;
        const line = raw.trim();
        if (!line) {
          if (idx < 0) break;
          continue;
        }
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          if (idx < 0) break;
          continue;
        }
        if (!obj || typeof obj !== "object") {
          if (idx < 0) break;
          continue;
        }

        if (obj.type === "session" && typeof obj.cwd === "string" && obj.cwd.trim()) {
          out.cwd = obj.cwd.trim();
        } else if (obj.type === "custom" || obj.type === "session_info") {
          const hit = noteFromEntry(obj);
          if (hit) {
            out.note = newerOf(out.note, hit);
          } else if (obj.type === "session_info" && typeof obj.name === "string") {
            const n = obj.name.trim();
            if (n) {
              out.info = newerOf(out.info, { name: n, timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "" });
            }
          }
        } else if (obj.type === "message" && obj.message && typeof obj.message === "object") {
          out.scannedMessages++;
          const role = obj.message.role;
          if (role === "user" || role === "assistant") {
            const text = extractTextContent(obj.message.content);
            if (text.trim() && out.messages.length < PREVIEW_MESSAGE_COUNT) {
              out.messages.push({ role, text: clipText(text, PREVIEW_MESSAGE_CHARS) });
            }
          }
          if (role === "user") {
            out.userMessages++;
            const text = extractTextContent(obj.message.content);
            if (text.trim() && out.firstUsers.length < 4) {
              out.firstUsers.push(text.trim());
            }
          } else if (role === "assistant") {
            out.assistantMessages++;
            if (!out.firstAssistant) {
              const text = extractTextContent(obj.message.content);
              if (text.trim()) out.firstAssistant = text.trim();
            }
            const content = obj.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") {
                  toolSet.add(block.name);
                }
              }
            }
          } else if (role === "toolResult" && typeof obj.message.toolName === "string") {
            toolSet.add(obj.message.toolName);
          }
        }

        if (idx < 0) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // unreadable
  }

  out.tools = [...toolSet].slice(0, 12);
  return out;
}

/**
 * Last-window scan. Secondary source only: it can only ever supply something NEWER than the
 * head window holds — in practice a manual rename (`session_info` written at the leaf) or our
 * own name pushed through `setSessionName()`. Its first line is a partial one unless the window
 * starts at the file start; whatever scrolls out of the window simply loses to the head copy.
 */
function scanSessionTail(sourcePath: string, size: number): { note?: NoteHit; info?: SessionInfoHit } {
  const start = Math.max(0, size - TAIL_SCAN_BYTES);
  const length = size - start;
  if (length <= 0) return {};
  try {
    const fd = fs.openSync(sourcePath, "r");
    try {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, start);
      const lines = splitCompleteLines(buf.toString("utf-8", 0, n));
      if (start > 0 && lines.length > 0) lines.shift();
      return { note: newestNoteInLines(lines), info: newestSessionInfoInLines(lines) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
}

function looksLikeFsPath(s: string): boolean {
  const t = s.trim();
  return (
    /^[A-Za-z]:[\\/]/.test(t) ||
    t.startsWith("\\\\") ||
    /^~[/\\]/.test(t) ||
    t.startsWith("/home/") ||
    t.startsWith("/Users/")
  );
}

function pickTitle(name: string | undefined, firstUsers: string[], fallback: string): string {
  if (name && name.trim()) return clip(name.trim(), 100);
  // Prefer human sentences over bare filesystem paths.
  for (const u of firstUsers) {
    if (/^\s*(hi|hello|hey|ok|okay|thanks|thx|yes|no)\b/i.test(u)) continue;
    if (looksLikeFsPath(u)) continue;
    if (u.trim().length >= 8) return clip(u, 100);
  }
  for (const u of firstUsers) {
    if (looksLikeFsPath(u)) {
      const leaf = u.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
      if (leaf) return clip(leaf, 80);
    }
    if (u.trim()) return clip(u, 100);
  }
  return fallback;
}

function metaFromScan(sourcePath: string, stat: fs.Stats, scan: HeadScan): LocalSessionMeta {
  const project = scan.cwd
    ? normalizeProjectPath(scan.cwd)
    : extractProjectFromSessionFile(sourcePath);
  const date = isoFromFilename(sourcePath);
  const basename = path.basename(sourcePath, ".jsonl");
  const firstUser = scan.firstUsers[0] ? clip(scan.firstUsers[0], 220) : undefined;

  // A manual rename or a re-annotation lands at the leaf — past the head window on any large
  // session. The tail only ever *upgrades* what the head found, so growth costs nothing.
  const tail = stat.size > HEAD_SCAN_BYTES ? scanSessionTail(sourcePath, stat.size) : undefined;
  const note = newerOf(scan.note, tail?.note);
  const info = newerOf(scan.info, tail?.info);

  let name = info?.name;
  let annotation: SessionAnnotation | undefined;
  if (note) {
    const noteTitle = note.note.title;
    if (noteTitle && (!info || stampOf(note.timestamp) >= stampOf(info.timestamp))) name = noteTitle;
    annotation = { title: name || noteTitle, summary: note.note.summary, at: note.note.at };
  }

  return {
    source_path: sourcePath,
    project,
    cwd: scan.cwd,
    date,
    mtime: stat.mtimeMs,
    sizeBytes: stat.size,
    name,
    title: pickTitle(name, scan.firstUsers, basename),
    annotation,
    firstUser,
    tools: scan.tools,
    userMessages: scan.userMessages,
    assistantMessages: scan.assistantMessages,
    scannedMessages: scan.scannedMessages,
    scanTruncated: scan.truncated,
  };
}

function metaFromFile(sourcePath: string, stat: fs.Stats): LocalSessionMeta {
  return metaFromScan(sourcePath, stat, scanSessionHead(sourcePath));
}

function emptyMeta(sourcePath: string): LocalSessionMeta {
  return {
    source_path: sourcePath,
    project: extractProjectFromSessionFile(sourcePath),
    date: isoFromFilename(sourcePath),
    mtime: 0,
    sizeBytes: 0,
    title: path.basename(sourcePath),
    tools: [],
    userMessages: 0,
    assistantMessages: 0,
    scannedMessages: 0,
    scanTruncated: false,
  };
}

/** Head-scan meta for one file (menu labels, export picker). Zeroed meta if unreadable. */
export function readSessionMeta(sourcePath: string): LocalSessionMeta {
  try {
    return metaFromFile(sourcePath, fs.statSync(sourcePath));
  } catch {
    return emptyMeta(sourcePath);
  }
}

export interface ListScopedOptions {
  cwd: string;
  scope: SessionScope;
  /** Max sessions after sort (default 80). */
  limit?: number;
  /** Override ~/.pi/agent/sessions (tests). */
  sessionsDir?: string;
  /** Exclude active session path. */
  excludeSourcePath?: string;
  /** If set, only this `--encoded--` sessions subdir (ignores scope matching). */
  dirName?: string;
}

/** One cwd folder under ~/.pi/agent/sessions/ (project picker). */
export interface SessionProject {
  dirName: string;
  project: string;
  count: number;
  mtime: number;
}

/**
 * Fast local list: filter session dirs by Pi encoding + scope, stat jsonl, head-scan for titles.
 * Does not full-parse session bodies (unlike built-in /resume).
 */
export function listScopedSessions(opts: ListScopedOptions): LocalSessionMeta[] {
  const sessionsDir = getSessionsRoot(opts.sessionsDir);
  const limit = opts.limit ?? 80;
  const exclude = opts.excludeSourcePath ? path.resolve(opts.excludeSourcePath) : undefined;
  const items: { mtime: number; path: string; size: number }[] = [];

  if (!fs.existsSync(sessionsDir)) return [];

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    if (opts.dirName) {
      if (ent.name !== opts.dirName) continue;
    } else if (!sessionDirMatchesScope(ent.name, opts.cwd, opts.scope)) {
      continue;
    }
    const dirPath = path.join(sessionsDir, ent.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dirPath, f);
      if (exclude && path.resolve(full) === exclude) continue;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (st.size > MAX_LIST_FILE_BYTES) continue;
        items.push({ mtime: st.mtimeMs, path: full, size: st.size });
      } catch {
        // skip
      }
    }
  }

  items.sort((a, b) => b.mtime - a.mtime);
  const sliced = items.slice(0, limit);
  const out: LocalSessionMeta[] = [];
  for (const it of sliced) {
    try {
      const st = fs.statSync(it.path);
      out.push(metaFromFile(it.path, st));
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * All session cwd folders (count + latest mtime). No head-scan of every jsonl —
 * peeks cwd from the newest file in each dir. Used by the By project picker.
 */
export function listSessionProjects(opts: { sessionsDir?: string } = {}): SessionProject[] {
  const sessionsDir = getSessionsRoot(opts.sessionsDir);
  if (!fs.existsSync(sessionsDir)) return [];

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SessionProject[] = [];
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.startsWith("--") || !ent.name.endsWith("--")) continue;
    const dirPath = path.join(sessionsDir, ent.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    let count = 0;
    let bestMtime = 0;
    let newestPath = "";
    for (const f of files) {
      const full = path.join(dirPath, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (st.size > MAX_LIST_FILE_BYTES) continue;
        count++;
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          newestPath = full;
        }
      } catch {
        // skip
      }
    }
    if (count === 0) continue;

    const project = newestPath
      ? extractProjectFromSessionFile(newestPath)
      : extractProject(path.join(dirPath, "session.jsonl"));
    out.push({ dirName: ent.name, project, count, mtime: bestMtime });
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Chat-style preview: head-scan meta + first dialog messages (never a full-file dump).
 * Rendered by session-viewer.
 */
export function buildChatPreview(sourcePath: string): ChatPreview {
  let st: fs.Stats;
  try {
    st = fs.statSync(sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source_path: sourcePath,
      project: extractProject(sourcePath),
      date: isoFromFilename(sourcePath),
      meta: emptyMeta(sourcePath),
      messages: [],
      note: `Cannot read session:\n${msg}`,
    };
  }

  const scan = scanSessionHead(sourcePath);
  const meta = metaFromScan(sourcePath, st, scan);
  return {
    source_path: sourcePath,
    project: meta.project,
    date: meta.date,
    meta,
    messages: scan.messages,
  };
}

/** Re-export for callers that only need cwd from header. */
export { readSessionCwd };
