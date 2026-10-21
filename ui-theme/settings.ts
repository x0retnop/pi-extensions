/**
 * uiTheme settings block in ~/.pi/agent/settings.json.
 * Still accepts legacy keys (statusFooter / smartFooter / noWorking) if present.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BarStyleId,
  type FrameFillId,
  type FrameStyleId,
  normalizeBarStyle,
  normalizeFrameFill,
  normalizeFrameStyle,
} from "./paint.js";
import {
  type SurfaceBootSettings,
  BOOT_DEFAULTS,
  mergeBootSettings,
  parseBootSettings,
} from "../common/chrome.js";

export const SETTINGS_KEY = "uiTheme";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Default B2 frame halves (#6496ff / #b464ff). */
export const DEFAULT_FRAME_BLU = "#6496ff";
export const DEFAULT_FRAME_PUR = "#b464ff";

export interface UiThemeSettings {
  /** Custom setFooter chrome (default true). */
  footer: boolean;
  /** Gradient frame around the custom footer (default true). */
  frame: boolean;
  /** Box glyphs: sharp ┌ / rounded ╭ / double ╔ / heavy ┏ / ascii + / block ▛. */
  frameStyle: FrameStyleId;
  /** Horizontal rule paint: split (halves) / solid / fade (lerp). */
  frameFill: FrameFillId;
  /** Optional label inset on the top rule. Empty = none. */
  frameTitle: string;
  /** Left half of frame gradient — hex #RRGGBB. */
  frameBlu: string;
  /** Right half of frame gradient — hex #RRGGBB. */
  framePur: string;
  /** CONTEXT / tok-s bar glyphs: block █░ / density █▓▒░ / hash #- / dot ●○. */
  barStyle: BarStyleId;
  /** Join between extension status blocks on footer line 3. Default ` | `. */
  statusSep: string;
  /** Tok/s rate bar via setStatus (default true). */
  rate: boolean;
  /** Bar ceiling for tok/s (default 170). */
  maxTps: number;
  /** Turn-log inline entries in scrollback (absorbed tool-timestamps; default true). */
  timeline: boolean;
  /** Live turn status block via setStatus (turn · elapsed · tools; default true). */
  turnLive: boolean;
  /** ASCII splash as a transient chat line on session_start (default true). */
  banner: boolean;
  /** Prefer this art name on splash (substring ok). Empty = random. */
  bannerPrefer: string;
  /** Show Pi's built-in Working... row (default false = hidden). */
  working: boolean;
  /** Last applied preset id (informational; re-apply from menu). */
  preset: string;
  /** Skin for extension ribbons (context-guard boot first). Colors from frameBlu/Pur. */
  boot: SurfaceBootSettings;
  /** Footer cell layout. Empty rows = stock 3-line chrome. */
  layout: FooterLayout;
}

export type CellAlign = "left" | "right";

export interface FooterCellSpec {
  /** Visible-char width. 0 = shrink-wrap. */
  w: number;
  align: CellAlign;
}

export interface FooterRowSpec {
  left: string[];
  right: string[];
}

export interface FooterLayout {
  /** First/last content lines sit in the frame corners (no extra ─ rules). */
  embed: boolean;
  /** Spaces after the left wall/corner before cells (0–8). */
  pad: number;
  /** Join between cells. Empty = use statusSep. */
  sep: string;
  /** Per-cell width/align. Keys = builtin ids or setStatus keys. */
  cells: Record<string, FooterCellSpec>;
  /** Rows of cell ids / literal seps. Empty = stock layout. */
  rows: FooterRowSpec[];
}

const MAX_CELL_W = 80;
const MAX_PAD = 8;
const MAX_ROWS = 6;
const MAX_TOKENS = 24;
const MAX_TOK_LEN = 32;
const MAX_CELL_KEYS = 40;

export function emptyLayout(): FooterLayout {
  return { embed: false, pad: 0, sep: "", cells: {}, rows: [] };
}

export function isEmptyLayout(l: FooterLayout): boolean {
  return !l.embed && l.pad === 0 && !l.sep && Object.keys(l.cells).length === 0 && l.rows.length === 0;
}

export function hasCustomRows(l: FooterLayout): boolean {
  return l.rows.length > 0;
}

function asAlign(v: unknown): CellAlign {
  return v === "right" ? "right" : "left";
}

function asWidth(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_CELL_W, Math.round(v)));
}

export function parseCellSpec(v: unknown): FooterCellSpec {
  if (typeof v === "number") return { w: asWidth(v), align: "left" };
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return { w: asWidth(o.w ?? o.width), align: asAlign(o.align) };
  }
  return { w: 0, align: "left" };
}

function parseTokens(v: unknown): string[] {
  let raw: unknown[] = [];
  if (typeof v === "string") raw = v.trim().split(/\s+/);
  else if (Array.isArray(v)) raw = v;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.replace(/[\r\n\t]/g, "");
    if (!t || t.length > MAX_TOK_LEN) continue;
    out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

export function parseFooterRow(v: unknown): FooterRowSpec | null {
  if (typeof v === "string") {
    const tokens = parseTokens(v);
    if (!tokens.length) return null;
    const pipe = tokens.indexOf("|");
    if (pipe >= 0) {
      return { left: tokens.slice(0, pipe), right: tokens.slice(pipe + 1) };
    }
    return { left: tokens, right: [] };
  }
  if (Array.isArray(v)) {
    const left = parseTokens(v);
    return left.length ? { left, right: [] } : null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const left = parseTokens(o.left);
    const right = parseTokens(o.right);
    if (!left.length && !right.length) return null;
    return { left, right };
  }
  return null;
}

export function parseFooterLayout(raw: unknown): FooterLayout {
  const empty = emptyLayout();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const o = raw as Record<string, unknown>;
  const cells: Record<string, FooterCellSpec> = {};
  if (o.cells && typeof o.cells === "object" && !Array.isArray(o.cells)) {
    for (const [key, spec] of Object.entries(o.cells as Record<string, unknown>)) {
      const k = key.trim();
      if (!k || k.length > MAX_TOK_LEN) continue;
      cells[k] = parseCellSpec(spec);
      if (Object.keys(cells).length >= MAX_CELL_KEYS) break;
    }
  }
  const rows: FooterRowSpec[] = [];
  if (Array.isArray(o.rows)) {
    for (const item of o.rows) {
      const row = parseFooterRow(item);
      if (row) rows.push(row);
      if (rows.length >= MAX_ROWS) break;
    }
  }
  const padRaw = o.pad;
  const pad =
    typeof padRaw === "number" && Number.isFinite(padRaw)
      ? Math.max(0, Math.min(MAX_PAD, Math.round(padRaw)))
      : 0;
  return {
    embed: o.embed === true,
    pad,
    sep: typeof o.sep === "string" ? normalizeStatusSep(o.sep, "") : "",
    cells,
    rows,
  };
}

export const DEFAULTS: UiThemeSettings = {
  footer: true,
  frame: true,
  frameStyle: "sharp",
  frameFill: "split",
  frameTitle: "",
  frameBlu: DEFAULT_FRAME_BLU,
  framePur: DEFAULT_FRAME_PUR,
  barStyle: "block",
  statusSep: " | ",
  rate: true,
  maxTps: 170,
  timeline: true,
  turnLive: true,
  banner: true,
  bannerPrefer: "",
  working: false,
  preset: "",
  boot: { ...BOOT_DEFAULTS },
  layout: emptyLayout(),
};

export function loadSettingsFile(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

export function saveSettingsFile(settings: Record<string, unknown>): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {
    // ignore
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  return v !== false;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Frame title: single line, collapsed spaces. Empty = no title. */
export function normalizeFrameTitle(v: unknown, fallback: string = ""): string {
  if (typeof v !== "string") return fallback;
  return v.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Status join: keep spaces, drop breaks, cap length. Empty = tight join. */
export function normalizeStatusSep(v: unknown, fallback: string = DEFAULTS.statusSep): string {
  if (typeof v !== "string") return fallback;
  const s = v.replace(/[\r\n\t]/g, "");
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** Normalize #RGB / #RRGGBB / bare hex → #RRGGBB lowercase, or fallback. */
export function normalizeHex(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  let h = v.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  return `#${h.toLowerCase()}`;
}

/** Merge uiTheme + legacy statusFooter / smartFooter / noWorking blocks. */
export function loadUiThemeSettings(rawFile?: Record<string, unknown>): UiThemeSettings {
  const file = rawFile ?? loadSettingsFile();
  const u = (file[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {};
  const sf = (file.statusFooter as Record<string, unknown> | undefined) ?? {};
  const sm = (file.smartFooter as Record<string, unknown> | undefined) ?? {};
  const nw = (file.noWorking as Record<string, unknown> | undefined) ?? {};

  let working = DEFAULTS.working;
  if (typeof u.working === "boolean") working = u.working;
  else if (typeof nw.enabled === "boolean") working = !nw.enabled;

  return {
    footer: bool(u.footer ?? sf.enabled, DEFAULTS.footer),
    frame: bool(u.frame ?? sf.frame, DEFAULTS.frame),
    frameStyle: normalizeFrameStyle(u.frameStyle, DEFAULTS.frameStyle),
    frameFill: normalizeFrameFill(u.frameFill, DEFAULTS.frameFill),
    frameTitle: normalizeFrameTitle(u.frameTitle, DEFAULTS.frameTitle),
    frameBlu: normalizeHex(u.frameBlu, DEFAULTS.frameBlu),
    framePur: normalizeHex(u.framePur, DEFAULTS.framePur),
    barStyle: normalizeBarStyle(u.barStyle, DEFAULTS.barStyle),
    statusSep: normalizeStatusSep(u.statusSep, DEFAULTS.statusSep),
    rate: bool(u.rate ?? sm.enabled ?? sm.showRate, DEFAULTS.rate),
    maxTps: num(u.maxTps ?? sm.maxTps, DEFAULTS.maxTps),
    timeline: bool(u.timeline, DEFAULTS.timeline),
    turnLive: bool(u.turnLive, DEFAULTS.turnLive),
    banner: bool(u.banner, DEFAULTS.banner),
    bannerPrefer: str(u.bannerPrefer, DEFAULTS.bannerPrefer).trim(),
    working,
    preset: str(u.preset, DEFAULTS.preset).trim(),
    boot: parseBootSettings(u.boot),
    layout: parseFooterLayout(u.layout),
  };
}

export function saveUiThemeSettings(s: UiThemeSettings): void {
  const file = loadSettingsFile();
  const block: Record<string, unknown> = {
    footer: s.footer,
    frame: s.frame,
    frameStyle: s.frameStyle,
    frameFill: s.frameFill,
    frameTitle: s.frameTitle,
    frameBlu: s.frameBlu,
    framePur: s.framePur,
    barStyle: s.barStyle,
    statusSep: s.statusSep,
    rate: s.rate,
    maxTps: s.maxTps,
    timeline: s.timeline,
    turnLive: s.turnLive,
    banner: s.banner,
    bannerPrefer: s.bannerPrefer,
    working: s.working,
    preset: s.preset,
    boot: { ...s.boot },
  };
  if (!isEmptyLayout(s.layout)) block.layout = s.layout;
  file[SETTINGS_KEY] = block;
  saveSettingsFile(file);
}

/** Also accept live settingsManager snapshot when available. */
export function loadFromCtx(ctx: { settingsManager?: { getSettings?: () => unknown } } | null): UiThemeSettings {
  try {
    const raw = ctx?.settingsManager?.getSettings?.();
    if (raw && typeof raw === "object") {
      return loadUiThemeSettings(raw as Record<string, unknown>);
    }
  } catch {
    // fall through to file
  }
  return loadUiThemeSettings();
}

/** Chrome fields only — used when applying a preset pack. */
export type ChromePatch = Partial<
  Pick<
    UiThemeSettings,
    | "footer"
    | "frame"
    | "frameStyle"
    | "frameFill"
    | "frameTitle"
    | "frameBlu"
    | "framePur"
    | "barStyle"
    | "statusSep"
    | "rate"
    | "maxTps"
    | "timeline"
    | "turnLive"
    | "banner"
    | "bannerPrefer"
    | "working"
  >
> & {
  boot?: Partial<SurfaceBootSettings>;
  layout?: unknown;
};

export function applyChromePatch(base: UiThemeSettings, patch: ChromePatch): UiThemeSettings {
  const next = { ...base };
  if (typeof patch.footer === "boolean") next.footer = patch.footer;
  if (typeof patch.frame === "boolean") next.frame = patch.frame;
  if (patch.frameStyle !== undefined) next.frameStyle = normalizeFrameStyle(patch.frameStyle, next.frameStyle);
  if (patch.frameFill !== undefined) next.frameFill = normalizeFrameFill(patch.frameFill, next.frameFill);
  if (patch.frameTitle !== undefined) next.frameTitle = normalizeFrameTitle(patch.frameTitle, next.frameTitle);
  if (patch.frameBlu !== undefined) next.frameBlu = normalizeHex(patch.frameBlu, next.frameBlu);
  if (patch.framePur !== undefined) next.framePur = normalizeHex(patch.framePur, next.framePur);
  if (patch.barStyle !== undefined) next.barStyle = normalizeBarStyle(patch.barStyle, next.barStyle);
  if (patch.statusSep !== undefined) next.statusSep = normalizeStatusSep(patch.statusSep, next.statusSep);
  if (typeof patch.rate === "boolean") next.rate = patch.rate;
  if (typeof patch.maxTps === "number" && patch.maxTps > 0) next.maxTps = patch.maxTps;
  if (typeof patch.timeline === "boolean") next.timeline = patch.timeline;
  if (typeof patch.turnLive === "boolean") next.turnLive = patch.turnLive;
  if (typeof patch.banner === "boolean") next.banner = patch.banner;
  if (typeof patch.bannerPrefer === "string") next.bannerPrefer = patch.bannerPrefer.trim();
  if (typeof patch.working === "boolean") next.working = patch.working;
  if (patch.boot !== undefined) next.boot = mergeBootSettings(next.boot, patch.boot);
  if (patch.layout !== undefined) next.layout = parseFooterLayout(patch.layout);
  return next;
}
