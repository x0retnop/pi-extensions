/**
 * ASCII splash as a transient chat line: rendered into the transcript via
 * `ctx.ui.notify(..., "info")` (TUI `showStatus`), so it scrolls with the
 * history, is never written to the session file, and is never sent to the
 * LLM. Gone on the next transcript rebuild (session switch / new session).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth } from "@earendil-works/pi-tui";

const ARTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "arts");
const ART_EXTS = new Set([".txt", ".art", ".ansi", ""]);

type Fg =
  | "accent"
  | "border"
  | "borderAccent"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "toolTitle"
  | "toolOutput"
  | "mdCode"
  | "mdHeading";

const FG_KEYS = new Set<string>([
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "toolTitle",
  "toolOutput",
  "mdCode",
  "mdHeading",
]);

type ColorMode = "auto" | "plain" | Fg;

interface Art {
  id: string;
  name: string;
  color: ColorMode;
  body: string[];
}

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function listArtFiles(): string[] {
  try {
    return readdirSync(ARTS_DIR)
      .filter((f) => !f.startsWith(".") && !f.startsWith("_"))
      .filter((f) => ART_EXTS.has(extname(f).toLowerCase()))
      .map((f) => join(ARTS_DIR, f))
      .sort();
  } catch {
    return [];
  }
}

function parseArtFile(path: string): Art | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let name = path.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "");
  let color: ColorMode = "auto";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      const m = trimmed.match(/^#\s*(\w+)\s*:\s*(.+?)\s*$/);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === "name" && val) name = val;
        else if (key === "color" && val) {
          const c = val.toLowerCase();
          if (c === "auto" || c === "plain" || FG_KEYS.has(c)) color = c as ColorMode;
        }
      }
      i++;
      continue;
    }
    break;
  }

  let end = lines.length;
  while (end > i && lines[end - 1].trim() === "") end--;
  const body = lines.slice(i, end);
  if (body.length === 0) return null;

  return { id: path, name, color, body };
}

function loadArts(): Art[] {
  const out: Art[] = [];
  for (const path of listArtFiles()) {
    const art = parseArtFile(path);
    if (art) out.push(art);
  }
  return out;
}

const BLOCK_HEAVY = /[█▓▀▄▌▐■●◆★]/u;
const BLOCK_LIGHT = /[░▒□○◇☆·]/u;
const BOX = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫╭╮╰╯┏┓┗┛━┃▛▜▙▟]/u;
const MARKUP_RE = /\{\{(\w+)\}\}([\s\S]*?)\{\{\/\}\}/g;

function hasMarkup(s: string): boolean {
  return s.includes("{{") && s.includes("{{/");
}

function colorizeMarkup(line: string, theme: ThemeLike): string {
  MARKUP_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKUP_RE.exec(line)) !== null) {
    out += line.slice(last, m.index);
    const key = m[1];
    const inner = m[2];
    out += FG_KEYS.has(key) ? theme.fg(key, inner) : inner;
    last = m.index + m[0].length;
  }
  out += line.slice(last);
  return out;
}

function charClass(ch: string): Fg | "plain" {
  if (BLOCK_HEAVY.test(ch)) return "accent";
  if (BLOCK_LIGHT.test(ch)) return "dim";
  if (BOX.test(ch)) return "border";
  if (ch === "*" || ch === ".") return "muted";
  if (ch === '"' || ch === "'" || ch === "`") return "mdCode";
  return "plain";
}

function colorizeAuto(line: string, theme: ThemeLike): string {
  if (!line) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\u001b") {
      let j = i + 1;
      while (j < line.length && line[j] !== "m") j++;
      out += line.slice(i, Math.min(j + 1, line.length));
      i = Math.min(j + 1, line.length);
      continue;
    }
    const cls = charClass(ch);
    let j = i + 1;
    while (j < line.length) {
      const c2 = line[j];
      if (c2 === "\u001b") break;
      if (charClass(c2) !== cls) break;
      j++;
    }
    const run = line.slice(i, j);
    out += cls === "plain" ? run : theme.fg(cls, run);
    i = j;
  }
  return out;
}

function colorizeLine(line: string, mode: ColorMode, theme: ThemeLike): string {
  if (mode === "plain") {
    return hasMarkup(line) ? colorizeMarkup(line, theme) : line;
  }
  if (mode !== "auto") {
    if (hasMarkup(line)) return colorizeMarkup(line, theme);
    return theme.fg(mode, line);
  }
  if (hasMarkup(line)) return colorizeMarkup(line, theme);
  return colorizeAuto(line, theme);
}

function renderArt(art: Pick<Art, "color" | "body">, theme: ThemeLike): string[] {
  return art.body.map((line) => colorizeLine(line, art.color, theme));
}

function fitLines(lines: string[], width: number | undefined): string[] {
  if (typeof width !== "number" || width < 2) return lines;
  return lines.map((line) => (line ? truncateToWidth(line, width, "") : line));
}

let lastId: string | undefined;

function pickArt(arts: Art[], preferName?: string): Art | undefined {
  if (arts.length === 0) return undefined;
  if (preferName) {
    const want = preferName.toLowerCase();
    const hit =
      arts.find((a) => a.name.toLowerCase() === want) ||
      arts.find((a) => a.name.toLowerCase().includes(want)) ||
      arts.find((a) => a.id.toLowerCase().includes(want));
    if (hit) {
      lastId = hit.id;
      return hit;
    }
  }
  if (arts.length === 1) {
    lastId = arts[0].id;
    return arts[0];
  }
  const pool = lastId ? arts.filter((a) => a.id !== lastId) : arts;
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? arts[0];
  lastId = pick.id;
  return pick;
}

// ---- transient chat-line rendering ----

/**
 * Pick an art, colorize it with the active theme, and render it as a
 * transient line in the chat transcript (notify → TUI showStatus).
 * `extraLines` (boot ribbon) are prepended so one notify carries both —
 * back-to-back notify calls replace each other.
 * Returns the art name, or undefined when no arts / no UI.
 */
export function showBanner(ctx: any, preferName?: string, extraLines?: string[]): string | undefined {
  if (!ctx?.hasUI || typeof ctx.ui?.notify !== "function") return undefined;
  const extra = extraLines?.length ? extraLines : [];
  const theme = ctx.ui?.theme as ThemeLike | undefined;
  let artName: string | undefined;
  let artLines: string[] = [];
  if (theme) {
    const arts = loadArts();
    const art = pickArt(arts, preferName);
    if (art) {
      // Truncate to the terminal width so the box art stays intact (Text would
      // wrap lines that exceed its content width).
      const width = Math.max(20, (process.stdout.columns ?? 120) - 2);
      artLines = fitLines(renderArt(art, theme), width);
      artName = art.name;
    }
  }
  const lines = extra.length && artLines.length
    ? [...extra, "", ...artLines]
    : extra.length
      ? extra
      : artLines;
  if (lines.length === 0) return undefined;
  ctx.ui.notify(lines.join("\n"), "info");
  return artName;
}

export function artsDir(): string {
  return ARTS_DIR;
}

export function listArtNames(): string[] {
  return loadArts().map((a) => a.name);
}
