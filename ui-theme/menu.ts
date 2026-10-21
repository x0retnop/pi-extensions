/**
 * /ui-theme — interactive TUI settings: presets, chrome toggles, Pi theme picker.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULTS,
  type UiThemeSettings,
  hasCustomRows,
  isEmptyLayout,
  normalizeStatusSep,
  saveUiThemeSettings,
} from "./settings.js";
import { listArtNames } from "./banner.js";
import {
  BAR_STYLE_IDS,
  FRAME_FILL_IDS,
  FRAME_STYLE_IDS,
  frameColorsFromHex,
  paint,
  type BarStyleId,
  type FrameFillId,
  type FrameStyleId,
} from "./paint.js";
import { SURFACE_FRAME_IDS, type SurfaceFrameId } from "../common/chrome.js";
import {
  type UiThemePreset,
  applyPreset,
  findPreset,
  loadPresets,
  presetsDir,
} from "./presets.js";

function formatMenuItem(id: string, label: string, enabled: boolean): string {
  return `${enabled ? "●" : "○"}  ${label}  [${id}]`;
}

function parseIdFromMenuItem(item: string): string | undefined {
  const match = item.match(/\[([^\]]+)\]\s*$/);
  return match?.[1];
}

function layoutSummary(s: UiThemeSettings): string {
  const l = s.layout;
  if (isEmptyLayout(l)) return "stock";
  const widths = Object.keys(l.cells).length;
  const bits: string[] = [];
  if (hasCustomRows(l)) bits.push(`${l.rows.length} rows`);
  else bits.push("stock rows");
  if (l.embed) bits.push("embed");
  if (l.pad) bits.push(`pad ${l.pad}`);
  if (l.sep) bits.push(`sep=${JSON.stringify(l.sep)}`);
  if (widths) bits.push(`${widths} cell widths`);
  return bits.join(", ");
}

function currentPiTheme(ctx: ExtensionCommandContext): string {
  try {
    const name = (ctx as any).settingsManager?.getTheme?.() ?? (ctx.ui as any).theme?.name;
    if (typeof name === "string" && name) return name;
  } catch {
    // ignore
  }
  try {
    const n = (ctx.ui as any).theme?.name;
    if (typeof n === "string" && n) return n;
  } catch {
    // ignore
  }
  return "?";
}

export interface MenuActions {
  getSettings: () => UiThemeSettings;
  setSettings: (s: UiThemeSettings) => void;
  applyAll: (ctx: ExtensionCommandContext) => void;
  showBanner: (ctx: ExtensionCommandContext, name?: string) => string | undefined;
}

function finishPreset(
  ctx: ExtensionCommandContext,
  actions: MenuActions,
  preset: UiThemePreset,
): void {
  const result = applyPreset(preset, actions.getSettings(), ctx);
  actions.setSettings(result.settings);
  actions.applyAll(ctx);

  if (result.settings.banner) {
    const prefer = result.settings.bannerPrefer || undefined;
    actions.showBanner(ctx, prefer);
  }

  const bits = [`preset → ${preset.name}`];
  if (result.piThemeApplied) bits.push(`Pi theme → ${result.piThemeApplied}`);
  if (result.piThemeError) bits.push(`Pi theme err: ${result.piThemeError}`);
  ctx.ui.notify(bits.join(" · "), result.piThemeError ? "warning" : "info");
}

async function pickPreset(ctx: ExtensionCommandContext, actions: MenuActions): Promise<void> {
  const presets = loadPresets();
  if (presets.length === 0) {
    ctx.ui.notify(`No presets in ${presetsDir()}`, "warning");
    return;
  }
  const cur = actions.getSettings().preset;
  const options = presets.map((p) => {
    const mark = p.id === cur ? "→ " : "  ";
    const pi = p.piTheme ? `pi:${p.piTheme}` : "pi:(keep)";
    const desc = p.description ? ` — ${p.description}` : "";
    const short = desc.length > 50 ? desc.slice(0, 47) + "…" : desc;
    // id in trailing [brackets] for stable parse
    return `${mark}${p.name}  (${pi})${short}  [${p.id}]`;
  });
  options.push("", "← Back");

  const choice = await ctx.ui.select("Apply preset (Pi theme + chrome)", options);
  if (!choice || choice === "← Back") return;

  const id = parseIdFromMenuItem(choice);
  const preset = id ? presets.find((p) => p.id === id) || findPreset(id) : undefined;
  if (!preset) {
    ctx.ui.notify(`Preset not found`, "warning");
    return;
  }
  finishPreset(ctx, actions, preset);
}

async function pickPiTheme(ctx: ExtensionCommandContext): Promise<void> {
  let themes: { name: string; path: string | undefined }[] = [];
  try {
    themes = ctx.ui.getAllThemes?.() ?? [];
  } catch {
    themes = [];
  }
  if (themes.length === 0) {
    ctx.ui.notify("No themes discovered (ctx.ui.getAllThemes empty)", "warning");
    return;
  }

  const cur = currentPiTheme(ctx);
  const options = themes.map((t) => {
    const mark = t.name === cur ? "→ " : "  ";
    const src = t.path ? "  · file" : "  · built-in";
    return `${mark}${t.name}${src}`;
  });
  options.push("", "← Back");

  const choice = await ctx.ui.select(`Pi theme (current: ${cur})`, options);
  if (!choice || choice === "← Back") return;

  const name = choice.replace(/^[→ ]\s*/, "").replace(/\s+·\s+(file|built-in)\s*$/, "").trim();
  if (!name) return;

  const result = ctx.ui.setTheme(name);
  if (result?.success === false) {
    ctx.ui.notify(`Theme failed: ${result.error ?? "unknown"}`, "error");
    return;
  }
  ctx.ui.notify(`Pi theme → ${name}`, "info");
}

async function showChromeInfo(ctx: ExtensionCommandContext, s: UiThemeSettings): Promise<void> {
  const arts = listArtNames();
  const fc = frameColorsFromHex(s.frameBlu, s.framePur);
  const lines = [
    "ui-theme chrome",
    "",
    `preset:   ${s.preset || "(none)"}`,
    `footer:   ${s.footer ? "custom" : "built-in"}`,
    `frame:    ${s.frame ? "on" : "off"}  ${s.frameStyle}/${s.frameFill}  ${paint(fc.blu, "─")} ${paint(fc.pur, "─")}  ${s.frameBlu} → ${s.framePur}`,
    `          title=${s.frameTitle || "(none)"}`,
    `bar:      ${s.barStyle}`,
    `statusSep:${JSON.stringify(s.statusSep)}`,
    `layout:   ${layoutSummary(s)}`,
    `rate:     ${s.rate ? "on" : "off"}  maxTps=${s.maxTps}`,
    `timeline: ${s.timeline ? "on" : "off"}  turn log entries in scrollback`,
    `turnLive: ${s.turnLive ? "on" : "off"}  live turn status in status bar`,
    `banner:   ${s.banner ? "on" : "off"}  prefer=${s.bannerPrefer || "(random)"}`,
    `          arts: ${arts.length ? arts.join(", ") : "(none)"}`,
    `working:  ${s.working ? "visible" : "hidden"}`,
    `boot:     frame=${s.boot.frame}  title=${s.boot.title}  rails=${s.boot.rails ? "on" : "off"}`,
    "",
    "Pi theme tokens (accent/dim/success/…) = active theme JSON.",
    "Frame shape = frameStyle / frameFill / frameTitle; colors = frameBlu / framePur.",
    "Boot ribbon (context-guard) = chrome.boot; extras (itemLead/Mark, catMark) via preset JSON.",
    "Bars = barStyle (CONTEXT in footer + tok/s status).",
    "Footer layout = chrome.layout (rows + cell widths). Empty rows = stock 3-line.",
    "Presets: ui-theme/presets/*.json  →  docs/extensions/ui-theme-presets.md",
    "settings.json key: uiTheme",
    "",
    "[Esc/q close]",
  ];

  await ctx.ui.custom<void>((_tui, _theme, kb, done) => ({
    render: () => lines,
    invalidate: () => {},
    handleInput: (data: string) => {
      if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
        done();
      }
    },
  }));
}

export async function runUiThemeMenu(ctx: ExtensionCommandContext, actions: MenuActions): Promise<void> {
  if (!ctx.hasUI) return;

  while (true) {
    const s = actions.getSettings();
    const piTheme = currentPiTheme(ctx);
    const presetLabel = s.preset ? s.preset : "—";
    const options = [
      `📦  Preset: ${presetLabel}  (apply pack)`,
      `🎨  Pi theme: ${piTheme}`,
      "",
      formatMenuItem("footer", "Custom footer (setFooter chrome)", s.footer),
      formatMenuItem("frame", "Footer gradient frame", s.frame),
      `▣  Frame style: ${s.frameStyle}  [frameStyle]`,
      `▣  Frame fill: ${s.frameFill}  [frameFill]`,
      `▣  Frame title: ${s.frameTitle || "(none)"}  [frameTitle]`,
      `▣  Bar style: ${s.barStyle}  [barStyle]`,
      `▣  Status sep: ${JSON.stringify(s.statusSep)}  [statusSep]`,
      formatMenuItem("rate", "Tok/s rate bar in status", s.rate),
      `⚙  Rate ceiling (maxTps): ${s.maxTps}  [maxTps]`,
      formatMenuItem("timeline", "Turn log entries in scrollback", s.timeline),
      formatMenuItem("turnLive", "Live turn status in status bar", s.turnLive),
      formatMenuItem("banner", "Session ASCII banner", s.banner),
      `🖼  Banner prefer: ${s.bannerPrefer || "(random)"}  [bannerPrefer]`,
      formatMenuItem("working", "Show Working… spinner row", s.working),
      `▣  Boot frame: ${s.boot.frame}  [bootFrame]`,
      formatMenuItem("bootRails", "Boot rails (▓▓)", s.boot.rails),
      "",
      "▶  Reshow banner now",
      "ℹ  Chrome info / what is configurable",
      "↺  Reset chrome defaults",
      "",
      "← Done",
    ];

    const choice = await ctx.ui.select("ui-theme", options);
    if (!choice || choice === "← Done") return;

    if (choice.startsWith("📦")) {
      await pickPreset(ctx, actions);
      continue;
    }

    if (choice.startsWith("🎨")) {
      await pickPiTheme(ctx);
      continue;
    }

    if (choice.startsWith("▶")) {
      const name = actions.showBanner(ctx, s.bannerPrefer || undefined);
      if (!name) ctx.ui.notify("No arts in ui-theme/arts/", "warning");
      continue;
    }

    if (choice.startsWith("ℹ")) {
      await showChromeInfo(ctx, s);
      continue;
    }

    if (choice.startsWith("↺")) {
      const ok = await ctx.ui.confirm(
        "Reset ui-theme chrome?",
        "Restores footer/frame/colors/rate/banner/working defaults. Pi theme unchanged.",
      );
      if (ok) {
        actions.setSettings({ ...DEFAULTS });
        saveUiThemeSettings(actions.getSettings());
        actions.applyAll(ctx);
        ctx.ui.notify("ui-theme chrome → defaults", "info");
      }
      continue;
    }

    const id = parseIdFromMenuItem(choice);
    if (!id) continue;

    if (id === "maxTps") {
      const raw = await ctx.ui.input("Tok/s bar ceiling (maxTps)", String(s.maxTps));
      if (raw === undefined) continue;
      const n = Number(raw.trim());
      if (!Number.isFinite(n) || n <= 0) {
        ctx.ui.notify("maxTps must be a positive number", "warning");
        continue;
      }
      actions.setSettings({ ...s, maxTps: Math.round(n), preset: "" });
      saveUiThemeSettings(actions.getSettings());
      actions.applyAll(ctx);
      ctx.ui.notify(`maxTps → ${Math.round(n)}`, "info");
      continue;
    }

    if (id === "frameStyle") {
      const options = FRAME_STYLE_IDS.map((id) => `${id === s.frameStyle ? "→ " : "  "}${id}`);
      options.push("", "← Back");
      const choice = await ctx.ui.select("Frame style (box glyphs)", [...options]);
      if (!choice || choice === "← Back") continue;
      const nextStyle = choice.replace(/^[→ ]\s*/, "").trim() as FrameStyleId;
      if (!(FRAME_STYLE_IDS as readonly string[]).includes(nextStyle)) continue;
      actions.setSettings({ ...s, frameStyle: nextStyle, preset: "" });
      saveUiThemeSettings(actions.getSettings());
      actions.applyAll(ctx);
      ctx.ui.notify(`frameStyle → ${nextStyle}`, "info");
      continue;
    }

    if (id === "frameFill") {
      const options = FRAME_FILL_IDS.map((id) => `${id === s.frameFill ? "→ " : "  "}${id}`);
      options.push("", "← Back");
      const choice = await ctx.ui.select("Frame fill (rule paint)", [...options]);
      if (!choice || choice === "← Back") continue;
      const nextFill = choice.replace(/^[→ ]\s*/, "").trim() as FrameFillId;
      if (!(FRAME_FILL_IDS as readonly string[]).includes(nextFill)) continue;
      actions.setSettings({ ...s, frameFill: nextFill, preset: "" });
      saveUiThemeSettings(actions.getSettings());
      actions.applyAll(ctx);
      ctx.ui.notify(`frameFill → ${nextFill}`, "info");
      continue;
    }

    if (id === "frameTitle") {
      const raw = await ctx.ui.input("Frame title (empty = none)", s.frameTitle);
      if (raw === undefined) continue;
      const title = raw.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
      actions.setSettings({ ...s, frameTitle: title, preset: "" });
      saveUiThemeSettings(actions.getSettings());
      actions.applyAll(ctx);
      ctx.ui.notify(`frameTitle → ${title || "(none)"}`, "info");
      continue;
    }

    if (id === "statusSep") {
      const raw = await ctx.ui.input("Status separator (empty = tight)", s.statusSep);
      if (raw === undefined) continue;
      const sep = normalizeStatusSep(raw, s.statusSep);
      actions.setSettings({ ...s, statusSep: sep, preset: "" });
      saveUiThemeSettings(actions.getSettings());
      actions.applyAll(ctx);
      ctx.ui.notify(`statusSep → ${JSON.stringify(sep)}`, "info");
      continue;
    }

    if (id === "barStyle") {
      const options = BAR_STYLE_IDS.map((id) => `${id === s.barStyle ? "→ " : "  "}${id}`);
      options.push("", "← Back");
      const choice = await ctx.ui.select("Bar style (CONTEXT + tok/s glyphs)", [...options]);
      if (!choice || choice === "← Back") continue;
      const nextBar = choice.replace(/^[→ ]\s*/, "").trim() as BarStyleId;
      if (!(BAR_STYLE_IDS as readonly string[]).includes(nextBar)) continue;
      actions.setSettings({ ...s, barStyle: nextBar, preset: "" });
      saveUiThemeSettings(actions.getSettings());
      actions.applyAll(ctx);
      ctx.ui.notify(`barStyle → ${nextBar}`, "info");
      continue;
    }

    if (id === "bootFrame") {
      const options = SURFACE_FRAME_IDS.map((id) => `${id === s.boot.frame ? "→ " : "  "}${id}`);
      options.push("", "← Back");
      const choice = await ctx.ui.select("Boot ribbon frame (next session start)", [...options]);
      if (!choice || choice === "← Back") continue;
      const nextFrame = choice.replace(/^[→ ]\s*/, "").trim() as SurfaceFrameId;
      if (!(SURFACE_FRAME_IDS as readonly string[]).includes(nextFrame)) continue;
      actions.setSettings({ ...s, boot: { ...s.boot, frame: nextFrame }, preset: "" });
      saveUiThemeSettings(actions.getSettings());
      ctx.ui.notify(`boot.frame → ${nextFrame} (next session start)`, "info");
      continue;
    }

    if (id === "bannerPrefer") {
      const arts = listArtNames();
      const hint = arts.length ? `arts: ${arts.join(", ")}` : "no arts loaded";
      const raw = await ctx.ui.input(`Banner prefer (${hint}; empty = random)`, s.bannerPrefer);
      if (raw === undefined) continue;
      actions.setSettings({ ...s, bannerPrefer: raw.trim(), preset: "" });
      saveUiThemeSettings(actions.getSettings());
      ctx.ui.notify(`bannerPrefer → ${raw.trim() || "(random)"}`, "info");
      continue;
    }

    const next = { ...s, preset: "" };
    if (id === "footer") next.footer = !s.footer;
    else if (id === "frame") next.frame = !s.frame;
    else if (id === "rate") next.rate = !s.rate;
    else if (id === "timeline") next.timeline = !s.timeline;
    else if (id === "turnLive") next.turnLive = !s.turnLive;
    else if (id === "banner") next.banner = !s.banner;
    else if (id === "working") next.working = !s.working;
    else if (id === "bootRails") next.boot = { ...s.boot, rails: !s.boot.rails };
    else continue;

    actions.setSettings(next);
    saveUiThemeSettings(next);
    actions.applyAll(ctx);

    const label =
      id === "footer"
        ? `footer → ${next.footer ? "custom" : "built-in"}`
        : id === "working"
          ? `working → ${next.working ? "visible" : "hidden"}`
          : id === "bootRails"
            ? `boot.rails → ${next.boot.rails ? "on" : "off"} (next session start)`
            : `${id} → ${next[id as keyof UiThemeSettings] ? "on" : "off"}`;
    ctx.ui.notify(label, "info");
  }
}

/** CLI-style apply used by `/ui-theme preset <id>`. */
export function applyPresetByName(
  ctx: ExtensionCommandContext,
  actions: MenuActions,
  name: string,
): boolean {
  const preset = findPreset(name);
  if (!preset) {
    ctx.ui.notify(`Unknown preset "${name}". Dir: ${presetsDir()}`, "warning");
    return false;
  }
  finishPreset(ctx, actions, preset);
  return true;
}
