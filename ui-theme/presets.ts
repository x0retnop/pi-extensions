/**
 * Load / apply ui-theme presets from ./presets/*.json
 *
 * A preset = optional Pi theme name + chrome pack (footer/frame/rate/banner…).
 * See docs/extensions/ui-theme-presets.md for the authoring schema.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ChromePatch,
  type UiThemeSettings,
  applyChromePatch,
  normalizeFrameTitle,
  normalizeHex,
  normalizeStatusSep,
  parseFooterLayout,
  saveUiThemeSettings,
} from "./settings.js";
import { isBarStyle, isFrameFill, isFrameStyle } from "./paint.js";
import { bootPatchFromRaw } from "../common/chrome.js";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "presets");

export interface UiThemePreset {
  /** File stem / id (unique). */
  id: string;
  /** Display name (defaults to id). */
  name: string;
  description: string;
  /** Pi theme name to setTheme(); empty/omit = leave current Pi theme alone. */
  piTheme: string;
  chrome: ChromePatch;
  sourcePath: string;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return undefined;
}

function asStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  return undefined;
}

function parsePresetFile(path: string): UiThemePreset | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = asStr(o.id)?.trim() || basename(path, extname(path));
  if (!id) return null;

  // Prefer nested chrome{}; also accept flat chrome keys on root for tiny files.
  const c = (
    o.chrome && typeof o.chrome === "object" ? o.chrome : o
  ) as Record<string, unknown>;

  const chrome: ChromePatch = {};
  const footer = asBool(c.footer);
  const frame = asBool(c.frame);
  const rate = asBool(c.rate);
  const timeline = asBool(c.timeline);
  const turnLive = asBool(c.turnLive);
  const banner = asBool(c.banner);
  const working = asBool(c.working);
  const maxTps = asNum(c.maxTps);
  const bannerPrefer = asStr(c.bannerPrefer);
  if (footer !== undefined) chrome.footer = footer;
  if (frame !== undefined) chrome.frame = frame;
  if (rate !== undefined) chrome.rate = rate;
  if (timeline !== undefined) chrome.timeline = timeline;
  if (turnLive !== undefined) chrome.turnLive = turnLive;
  if (banner !== undefined) chrome.banner = banner;
  if (working !== undefined) chrome.working = working;
  if (maxTps !== undefined) chrome.maxTps = maxTps;
  if (bannerPrefer !== undefined) chrome.bannerPrefer = bannerPrefer;
  if (isFrameStyle(c.frameStyle)) chrome.frameStyle = c.frameStyle;
  if (isFrameFill(c.frameFill)) chrome.frameFill = c.frameFill;
  if (c.frameTitle !== undefined) chrome.frameTitle = normalizeFrameTitle(c.frameTitle, "");
  if (c.frameBlu !== undefined) chrome.frameBlu = normalizeHex(c.frameBlu, "#6496ff");
  if (c.framePur !== undefined) chrome.framePur = normalizeHex(c.framePur, "#b464ff");
  if (isBarStyle(c.barStyle)) chrome.barStyle = c.barStyle;
  if (typeof c.statusSep === "string") chrome.statusSep = normalizeStatusSep(c.statusSep, " | ");
  const boot = bootPatchFromRaw(c.boot);
  if (boot) chrome.boot = boot;
  if (c.layout !== undefined) chrome.layout = parseFooterLayout(c.layout);

  return {
    id,
    name: asStr(o.name)?.trim() || id,
    description: asStr(o.description)?.trim() || "",
    piTheme: asStr(o.piTheme)?.trim() || "",
    chrome,
    sourcePath: path,
  };
}

/** All presets from ui-theme/presets/*.json (sorted by name). */
export function loadPresets(): UiThemePreset[] {
  if (!existsSync(PRESETS_DIR)) return [];
  let files: string[];
  try {
    files = readdirSync(PRESETS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_") && !f.startsWith("."))
      .map((f) => join(PRESETS_DIR, f))
      .sort();
  } catch {
    return [];
  }
  const out: UiThemePreset[] = [];
  for (const path of files) {
    const p = parsePresetFile(path);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function findPreset(idOrName: string): UiThemePreset | undefined {
  const want = idOrName.trim().toLowerCase();
  if (!want) return undefined;
  const all = loadPresets();
  return (
    all.find((p) => p.id.toLowerCase() === want) ||
    all.find((p) => p.name.toLowerCase() === want) ||
    all.find((p) => p.id.toLowerCase().includes(want) || p.name.toLowerCase().includes(want))
  );
}

export function presetsDir(): string {
  return PRESETS_DIR;
}

export interface ApplyPresetResult {
  settings: UiThemeSettings;
  piThemeApplied: string | null;
  piThemeError?: string;
}

/**
 * Merge chrome → settings, persist, optionally setTheme.
 * Caller must run applyAll(ctx) + banner after this.
 */
export function applyPreset(
  preset: UiThemePreset,
  base: UiThemeSettings,
  ctx: ExtensionContext | null,
): ApplyPresetResult {
  const settings: UiThemeSettings = {
    ...applyChromePatch(base, preset.chrome),
    preset: preset.id,
  };
  saveUiThemeSettings(settings);

  let piThemeApplied: string | null = null;
  let piThemeError: string | undefined;
  if (preset.piTheme && ctx?.hasUI && typeof ctx.ui?.setTheme === "function") {
    try {
      const result = ctx.ui.setTheme(preset.piTheme);
      if (result && result.success === false) {
        piThemeError = result.error ?? "setTheme failed";
      } else {
        piThemeApplied = preset.piTheme;
      }
    } catch (e) {
      piThemeError = e instanceof Error ? e.message : String(e);
    }
  }

  return { settings, piThemeApplied, piThemeError };
}
