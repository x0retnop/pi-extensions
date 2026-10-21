/**
 * Skin for compact extension ribbons (first consumer: context-guard boot).
 * Glyphs + optional box; colors inherited from uiTheme frameBlu/Pur.
 * Preset JSON writes `uiTheme.boot` — no feature names here.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type FrameFillId,
  type FrameStyleId,
  FRAME_PUR,
  FRAME_STYLE_IDS,
  frameBox,
  hexToFgAnsi,
  isFrameFill,
  isFrameStyle,
  normalizeFrameFill,
  paint,
  RESET,
  visibleLen,
} from "./paint.js";

export type SurfaceFrameId = FrameStyleId | "none";
export type SurfaceTitleId = "prefix" | "in-border" | "none";

export const SURFACE_FRAME_IDS: readonly SurfaceFrameId[] = ["none", ...FRAME_STYLE_IDS];
export const SURFACE_TITLE_IDS: readonly SurfaceTitleId[] = ["prefix", "in-border", "none"];

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const DEFAULT_BLU = "#6496ff";
const DEFAULT_PUR = "#b464ff";
const DIM = "\x1b[2m";

/** Boot/ribbon fields stored under `uiTheme.boot`. Colors come from the footer frame. */
export interface SurfaceBootSettings {
  frame: SurfaceFrameId;
  title: SurfaceTitleId;
  rails: boolean;
  rail: string;
  sep: string;
  itemLead: string;
  itemMark: string;
  catMark: string;
  frameTitle: string;
}

export interface SurfaceChrome extends SurfaceBootSettings {
  frameBlu: string;
  framePur: string;
  frameFill: FrameFillId;
}

export const BOOT_DEFAULTS: SurfaceBootSettings = {
  frame: "none",
  title: "prefix",
  rails: false,
  rail: "▓▓",
  sep: " · ",
  itemLead: "",
  itemMark: "",
  catMark: "",
  frameTitle: "",
};

export function isSurfaceFrame(v: unknown): v is SurfaceFrameId {
  return typeof v === "string" && (SURFACE_FRAME_IDS as readonly string[]).includes(v);
}

export function isSurfaceTitle(v: unknown): v is SurfaceTitleId {
  return typeof v === "string" && (SURFACE_TITLE_IDS as readonly string[]).includes(v);
}

export function normalizeSurfaceFrame(v: unknown, fallback: SurfaceFrameId = "none"): SurfaceFrameId {
  return isSurfaceFrame(v) ? v : fallback;
}

export function normalizeSurfaceTitle(v: unknown, fallback: SurfaceTitleId = "prefix"): SurfaceTitleId {
  return isSurfaceTitle(v) ? v : fallback;
}

/** Glyph/separator field: keep spaces, drop breaks, cap length. Empty string is valid. */
export function glyphStr(v: unknown, fallback: string, max = 12): string {
  if (typeof v !== "string") return fallback;
  const s = v.replace(/[\r\n\t]/g, "");
  return s.length > max ? s.slice(0, max) : s;
}

function titleStr(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  return v.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function parseBootSettings(raw: unknown, fallback: SurfaceBootSettings = BOOT_DEFAULTS): SurfaceBootSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    frame: normalizeSurfaceFrame(o.frame, fallback.frame),
    title: normalizeSurfaceTitle(o.title, fallback.title),
    rails: typeof o.rails === "boolean" ? o.rails : fallback.rails,
    rail: glyphStr(o.rail, fallback.rail, 8),
    sep: glyphStr(o.sep, fallback.sep, 12),
    itemLead: glyphStr(o.itemLead, fallback.itemLead, 8),
    itemMark: glyphStr(o.itemMark, fallback.itemMark, 8),
    catMark: glyphStr(o.catMark, fallback.catMark, 8),
    frameTitle: titleStr(o.frameTitle, fallback.frameTitle),
  };
}

/** Listed keys only — for preset chrome.boot so omitted extras stay as they are. */
export function bootPatchFromRaw(raw: unknown): Partial<SurfaceBootSettings> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const patch: Partial<SurfaceBootSettings> = {};
  if (isSurfaceFrame(o.frame)) patch.frame = o.frame;
  if (isSurfaceTitle(o.title)) patch.title = o.title;
  if (typeof o.rails === "boolean") patch.rails = o.rails;
  if (typeof o.rail === "string") patch.rail = glyphStr(o.rail, "", 8);
  if (typeof o.sep === "string") patch.sep = glyphStr(o.sep, "", 12);
  if (typeof o.itemLead === "string") patch.itemLead = glyphStr(o.itemLead, "", 8);
  if (typeof o.itemMark === "string") patch.itemMark = glyphStr(o.itemMark, "", 8);
  if (typeof o.catMark === "string") patch.catMark = glyphStr(o.catMark, "", 8);
  if (typeof o.frameTitle === "string") patch.frameTitle = titleStr(o.frameTitle, "");
  return Object.keys(patch).length ? patch : undefined;
}

export function mergeBootSettings(base: SurfaceBootSettings, patch: unknown): SurfaceBootSettings {
  if (!patch || typeof patch !== "object") return base;
  return parseBootSettings(patch, base);
}

export function toSurfaceChrome(
  boot: SurfaceBootSettings,
  inherit: { frameBlu?: string; framePur?: string; frameFill?: unknown; frameStyle?: unknown } = {},
): SurfaceChrome {
  return {
    ...boot,
    frameBlu: typeof inherit.frameBlu === "string" && inherit.frameBlu ? inherit.frameBlu : DEFAULT_BLU,
    framePur: typeof inherit.framePur === "string" && inherit.framePur ? inherit.framePur : DEFAULT_PUR,
    frameFill: isFrameFill(inherit.frameFill) ? inherit.frameFill : "split",
  };
}

/** `none` → footer frameStyle (or sharp). Explicit box styles stay as written. */
export function resolveBootFrame(
  bootFrame: SurfaceFrameId,
  footerStyle: unknown = "sharp",
): FrameStyleId {
  if (isFrameStyle(bootFrame)) return bootFrame;
  return isFrameStyle(footerStyle) ? footerStyle : "sharp";
}

/** Runtime: read `settings.json` → uiTheme.boot + frame colors. Tests should pass chrome explicitly. */
export function loadSurfaceChrome(rawFile?: Record<string, unknown>): SurfaceChrome {
  let file = rawFile;
  if (!file) {
    try {
      if (existsSync(SETTINGS_PATH)) {
        file = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
      }
    } catch {
      file = undefined;
    }
  }
  const u = (file?.uiTheme as Record<string, unknown> | undefined) ?? {};
  const boot = parseBootSettings(u.boot);
  return toSurfaceChrome(
    { ...boot, frame: resolveBootFrame(boot.frame, u.frameStyle) },
    {
      frameBlu: typeof u.frameBlu === "string" ? u.frameBlu : DEFAULT_BLU,
      framePur: typeof u.framePur === "string" ? u.framePur : DEFAULT_PUR,
      frameFill: u.frameFill,
      frameStyle: u.frameStyle,
    },
  );
}

/** Always one blank row after the ribbon (separator before the editor). */
export function withRibbonGap(lines: string[]): string[] {
  if (lines.length === 0) return [];
  if (lines[lines.length - 1] === "") return lines;
  return [...lines, ""];
}

/** One-shot boot lines for the session-start splash. ui-theme takes these into its notify. */
let pendingBootRibbon: string[] | undefined;

export function queueBootRibbon(lines: string[]): void {
  pendingBootRibbon = lines.length ? lines : undefined;
}

export function takeBootRibbon(): string[] | undefined {
  const lines = pendingBootRibbon;
  pendingBootRibbon = undefined;
  return lines;
}

export interface RibbonGroup {
  label: string;
  items: string[];
}

function formatItems(items: string[], style: SurfaceChrome, pur: string): string {
  return items
    .map((it) => {
      const lead = style.itemLead ? paint(pur, style.itemLead) : "";
      const mark = style.itemMark ? paint(pur, style.itemMark) : "";
      return `${lead}${DIM}${it}${RESET}${mark}`;
    })
    .join(style.sep);
}

function formatGroupLine(group: RibbonGroup, style: SurfaceChrome, blu: string, pur: string): string {
  const body = formatItems(group.items, style, pur);
  if (style.title === "none") return body;
  const cat = paint(blu, group.label);
  const mark = style.catMark ? paint(pur, style.catMark) : "";
  const gap = style.catMark ? " " : "  ";
  return `${cat}${mark}${gap}${body}`;
}

function railLine(rail: string, width: number, blu: string): string {
  const unit = rail || "▓▓";
  const unitW = visibleLen(unit);
  if (unitW <= 0) return "";
  if (width <= unitW * 2) return paint(blu, unit);
  const mid = width - unitW * 2;
  return paint(blu, unit) + " ".repeat(mid) + paint(blu, unit);
}

/** Enabled-only groups → skinned lines. Empty groups dropped. Empty result = no splash. */
export function renderRibbon(groups: RibbonGroup[], style: SurfaceChrome): string[] {
  const rows = groups.filter((g) => g.items.length > 0);
  if (rows.length === 0) return [];

  const blu = hexToFgAnsi(style.frameBlu);
  const pur = hexToFgAnsi(style.framePur, FRAME_PUR);
  const lines = rows.map((g) => formatGroupLine(g, style, blu, pur));

  let out = lines;
  if (style.frame !== "none" && isFrameStyle(style.frame)) {
    const innerW = Math.max(1, ...lines.map(visibleLen));
    out = frameBox(lines, innerW, {
      style: style.frame,
      fill: style.frameFill,
      bluHex: style.frameBlu,
      purHex: style.framePur,
      title: style.title === "in-border" ? style.frameTitle : "",
    });
  }

  if (style.rails && style.rail) {
    const w = Math.max(1, ...out.map(visibleLen));
    const rail = railLine(style.rail, w, blu);
    if (rail) out = [rail, ...out, rail];
  }
  return out;
}
