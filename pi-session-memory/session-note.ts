/**
 * Session annotation stash — a generated title + summary stored at the TOP of a session file.
 *
 * Why the head, not the tail: this extension appends nothing itself, but Pi appends every new
 * message to the end. An entry written at the tail (the normal place for extension entries)
 * falls out of the `/sw` head scan (first 96 KB) as soon as the session grows — and it grows
 * with every later message, which is exactly the case this feature exists for. The head is
 * stable: appends never touch it, Pi never rewrites a v3 file, and the writer re-points the
 * first real entry at our line, so the tree keeps a single root:
 *
 *   {"type":"session",…}                                            header — byte-identical
 *   {"type":"custom","customType":"session-memory-note",…,"parentId":null,…}   ours
 *   {first real entry}                                               parentId → our id
 *   …rest of the file — byte-identical
 *
 * Re-annotation rewrites that same line (same id) and touches nothing else. The write is a
 * temp file + rename, guarded by a size/mtime check, so a concurrent Pi append is never lost.
 *
 * Reads are line-level helpers (`newestNoteInLines` / `newestSessionInfoInLines`) so the caller
 * can reuse whatever window it already read; `readSessionNote` is the whole-file convenience.
 */
import fs from "node:fs";

export const NOTE_CUSTOM_TYPE = "session-memory-note";
/** Marks the entry as ours (a plain `custom` entry from another extension must not match). */
export const NOTE_BY = "session-memory";
/** Non-hex prefix — Pi ids are hex, so a collision is impossible. */
export const NOTE_ID_PREFIX = "smn";

/** Sentinel at the head of the annotation request; used to find that request in the transcript. */
export const ANNOTATE_SENTINEL = "[session-memory:annotate]";

/** Head rewrite is a full-file copy — refuse monsters rather than risk a 100 MB write. */
export const MAX_REWRITE_BYTES = 64 * 1024 * 1024;

export interface SessionNote {
  title: string;
  summary: string;
  /** ISO stamp of the annotation. */
  at: string;
  /** provider/id that produced it, for debugging. */
  model?: string;
}

export interface NoteHit {
  note: SessionNote;
  /** Entry timestamp, used to pick the newest of several notes / a manual rename. */
  timestamp: string;
}

export interface SessionInfoHit {
  name: string;
  timestamp: string;
}

function ts(value: string | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function parseLine(line: string): any {
  const t = line.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Parse one entry; only our marked `custom` entry becomes a note. */
export function noteFromEntry(entry: any): NoteHit | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  if (entry.type !== "custom" || entry.customType !== NOTE_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object" || data.by !== NOTE_BY) return undefined;
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  if (!title && !summary) return undefined;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const at = typeof data.at === "string" && data.at ? data.at : timestamp;
  return {
    note: { title, summary, at, model: typeof data.model === "string" ? data.model : undefined },
    timestamp,
  };
}

/** Newest note among already-read raw JSONL lines. */
export function newestNoteInLines(lines: string[]): NoteHit | undefined {
  let best: NoteHit | undefined;
  for (const line of lines) {
    const hit = noteFromEntry(parseLine(line));
    if (hit && (!best || ts(hit.timestamp) >= ts(best.timestamp))) best = hit;
  }
  return best;
}

/** Newest `session_info` name among already-read raw JSONL lines (Pi's own naming slot). */
export function newestSessionInfoInLines(lines: string[]): SessionInfoHit | undefined {
  let best: SessionInfoHit | undefined;
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry || entry.type !== "session_info") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (!best || ts(timestamp) >= ts(best.timestamp)) best = { name, timestamp };
  }
  return best;
}

/** Split raw file bytes into complete lines; a trailing partial line is dropped. */
export function splitCompleteLines(text: string): string[] {
  const parts = text.split("\n");
  parts.pop();
  return parts;
}

function readWindow(fd: number, position: number, length: number): { text: string; bytes: number } {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return { text: buf.toString("utf-8", 0, n), bytes: n };
}

const READ_HEAD_BYTES = 96 * 1024;
const READ_TAIL_BYTES = 32 * 1024;

/**
 * Newest note in the whole file: head window first, then the tail window for a newer one.
 * The head holds what we wrote; the tail only matters when something newer landed there
 * (re-annotation on a resumed session, or a note written before this design).
 */
export function readSessionNote(sourcePath: string): NoteHit | undefined {
  let fd: number;
  try {
    fd = fs.openSync(sourcePath, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const head = readWindow(fd, 0, Math.min(size, READ_HEAD_BYTES));
    let best = newestNoteInLines(splitCompleteLines(head.text));
    if (head.bytes >= size) return best;
    const tailStart = Math.max(0, size - READ_TAIL_BYTES);
    const tail = readWindow(fd, tailStart, size - tailStart);
    const tailBest = newestNoteInLines(splitCompleteLines(tail.text));
    if (tailBest && (!best || ts(tailBest.timestamp) > ts(best.timestamp))) best = tailBest;
    return best;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const HEAD_PROBE_BYTES = 64 * 1024;
const MAX_HEAD_PROBE_BYTES = 2 * 1024 * 1024;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
/** Lines we must see complete: header, [our note], first real entry. */
const HEAD_PROBE_LINES = 4;

function readHeadLines(fd: number, minLines: number): string[] | undefined {
  let size = HEAD_PROBE_BYTES;
  for (;;) {
    const { text, bytes } = readWindow(fd, 0, size);
    const lines = splitCompleteLines(text);
    if (bytes < size || lines.length >= minLines) return lines;
    if (size >= MAX_HEAD_PROBE_BYTES) return undefined;
    size *= 2;
  }
}

/** Byte offset where line `index` starts (lines are LF-terminated). */
function lineOffset(lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += Buffer.byteLength(lines[i], "utf-8") + 1;
  return offset;
}

function copyRange(inFd: number, outFd: number, from: number, to: number): void {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(1, to - from)));
  let position = from;
  while (position < to) {
    const want = Math.min(buf.length, to - position);
    const n = fs.readSync(inFd, buf, 0, want, position);
    if (n <= 0) break;
    fs.writeSync(outFd, buf, 0, n);
    position += n;
  }
}

function newNoteId(): string {
  return `${NOTE_ID_PREFIX}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export interface WriteNoteResult {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
  /** Retrying cannot help (bad file, over the cap). */
  fatal?: boolean;
  /** Entry id of the note line. */
  id?: string;
  /** Size of the rewritten file. */
  bytes?: number;
}

/**
 * Insert or refresh the annotation line at the top of `sourcePath`.
 *
 * Preserves a single-root tree by re-pointing the parentId of the first real entry at our
 * line; on re-annotation that link already exists and nothing but our line is rewritten.
 * The original file is replaced atomically (temp + rename) and only if it did not change
 * between the read and the swap — otherwise the whole attempt is retried.
 */
export function writeSessionNote(sourcePath: string, note: SessionNote): WriteNoteResult {
  let lastError = "write failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = writeSessionNoteOnce(sourcePath, note);
    if (result.ok) return result;
    if (result.fatal) return { ok: false, error: result.error };
    lastError = result.error || lastError;
  }
  return { ok: false, error: lastError };
}

function writeSessionNoteOnce(sourcePath: string, note: SessionNote): WriteNoteResult {
  let before: fs.Stats;
  try {
    before = fs.statSync(sourcePath);
  } catch (err) {
    return { ok: false, error: `cannot stat session file: ${err instanceof Error ? err.message : String(err)}`, fatal: true };
  }
  if (before.size > MAX_REWRITE_BYTES) {
    return {
      ok: false,
      fatal: true,
      error: `session file is ${(before.size / 1048576).toFixed(1)} MB — over the 64 MB rewrite cap`,
    };
  }

  const tmpPath = `${sourcePath}.${process.pid}.smnote.tmp`;
  let inFd: number | undefined;
  let outFd: number | undefined;
  try {
    inFd = fs.openSync(sourcePath, "r");
    const lines = readHeadLines(inFd, HEAD_PROBE_LINES);
    if (!lines || lines.length === 0) return { ok: false, fatal: true, error: "cannot read session header" };
    const header = parseLine(lines[0]);
    if (!header || header.type !== "session") return { ok: false, fatal: true, error: "not a session file" };

    const secondEntry = parseLine(lines[1] ?? "");
    const existing = noteFromEntry(secondEntry);
    const id = existing && secondEntry && typeof secondEntry.id === "string" ? secondEntry.id : newNoteId();
    const firstRealIndex = existing ? 2 : 1;
    const firstReal = lines[firstRealIndex] === undefined ? undefined : parseLine(lines[firstRealIndex]);
    const realEntry = firstReal && typeof firstReal.id === "string" ? firstReal : undefined;

    const timestamp = note.at || new Date().toISOString();
    const noteLine = JSON.stringify({
      type: "custom",
      customType: NOTE_CUSTOM_TYPE,
      data: {
        by: NOTE_BY,
        title: note.title,
        summary: note.summary,
        at: timestamp,
        ...(note.model ? { model: note.model } : {}),
      },
      id,
      parentId: null,
      timestamp,
    });

    // Re-point the first real entry at our line so the tree keeps a single root. On
    // re-annotation that link already exists and the file is copied byte-for-byte.
    const repoint = realEntry !== undefined && realEntry.parentId !== id;
    let copyFrom: number;
    if (repoint) {
      const next = firstRealIndex + 1;
      copyFrom = next < lines.length ? lineOffset(lines, next) : before.size;
    } else {
      copyFrom = firstRealIndex < lines.length ? lineOffset(lines, firstRealIndex) : before.size;
    }

    outFd = fs.openSync(tmpPath, "w");
    fs.writeSync(outFd, lines[0] + "\n");
    fs.writeSync(outFd, noteLine + "\n");
    if (repoint && realEntry) fs.writeSync(outFd, JSON.stringify({ ...realEntry, parentId: id }) + "\n");
    copyRange(inFd, outFd, copyFrom, before.size);
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = undefined;
    fs.closeSync(inFd);
    inFd = undefined;

    const after = fs.statSync(sourcePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return { ok: false, error: "session file changed while annotating — retrying" };
    }

    fs.renameSync(tmpPath, sourcePath);
    return { ok: true, id, bytes: after.size };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (outFd !== undefined) {
      try {
        fs.closeSync(outFd);
      } catch {
        // ignore
      }
    }
    if (inFd !== undefined) {
      try {
        fs.closeSync(inFd);
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt + reply parsing
// ---------------------------------------------------------------------------

/** Instruction sent as a normal user turn, so the session's own model answers from its context. */
export function buildAnnotationPrompt(): string {
  return [
    `${ANNOTATE_SENTINEL} Составь навигационную аннотацию этой сессии.`,
    "Смотри на смысл и на итог всей сессии, а не на первое сообщение. Инструменты не вызывай, ничего не читай, длинно не размышляй.",
    "Ответь ровно двумя строками, без пояснений, без markdown и без кавычек:",
    "TITLE: <до 70 символов, по-русски, суть сессии>",
    "SUMMARY: <2-3 предложения по-русски, до 400 символов: что обсуждалось и чем закончилось>",
  ].join("\n");
}

export interface ParsedAnnotation {
  title: string;
  summary: string;
  /** Full model reply, kept for troubleshooting when the format is off. */
  raw: string;
}

function cleanField(value: string): string {
  return value
    .replace(/[*_`]/g, "")
    .replace(/^["'«»\s]+/, "")
    .replace(/["'«»\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim() + "…";
}

const TITLE_RE = /^(?:TITLE|ЗАГОЛОВОК)\s*[:：\-–—]\s*(.*)$/i;
const SUMMARY_RE = /^(?:SUMMARY|АННОТАЦИЯ|КРАТКО|ОПИСАНИЕ)\s*[:：\-–—]\s*(.*)$/i;

/**
 * Tolerant `TITLE:`/`SUMMARY:` reader: accepts fences, bullets, bold markers, Russian labels,
 * and a missing title (derived from the summary's first sentence).
 */
export function parseAnnotationReply(text: string): ParsedAnnotation | undefined {
  const raw = (text || "").trim();
  if (!raw) return undefined;

  const titleParts: string[] = [];
  const summaryParts: string[] = [];
  let mode: "title" | "summary" | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const cleaned = cleanField(line.replace(/^\s*(?:[#>*+-]+[.)]?\s*)+/, ""));
    if (!cleaned) continue;
    const title = cleaned.match(TITLE_RE);
    if (title) {
      mode = "title";
      if (title[1].trim()) titleParts.push(title[1]);
      continue;
    }
    const summary = cleaned.match(SUMMARY_RE);
    if (summary) {
      mode = "summary";
      if (summary[1].trim()) summaryParts.push(summary[1]);
      continue;
    }
    if (mode === "summary") summaryParts.push(cleaned);
    else if (mode === "title" && titleParts.length === 0) titleParts.push(cleaned);
  }

  let title = cleanField(titleParts.join(" "));
  let summary = cleanField(summaryParts.join(" "));
  if (!title && summary) title = clip(summary, 120);
  if (!title && !summary) return undefined;
  // Caps are safety valves, not the target: the prompt asks for 70/400, so a normal answer is
  // stored verbatim. A tight cap here would cut a word the model meant to keep (it overshoots).
  return { title: clip(title, 120), summary: clip(summary, 600), raw };
}
