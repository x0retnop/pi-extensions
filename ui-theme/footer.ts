/**
 * Custom footer via ctx.ui.setFooter.
 * Stock:
 *   line 1: cwd • session                         model (right)
 *   line 2: ↑tokens CONTEXT-bar ▸ rate
 *   line 3: extension statuses joined by statusSep
 * Custom layout (uiTheme.layout.rows): named cells, fixed widths, left/right.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ThemeLike,
  bar,
  frameBox,
  frameColorsFromHex,
  fitVisible,
  padEndVisible,
  seg,
  trunc,
} from "./paint.js";
import { DEFAULTS, type FooterLayout, type UiThemeSettings } from "./settings.js";
import { RATE_STATUS_KEY, getRateParts } from "./rate.js";
import {
  consumedStatusKeys,
  placeLeftRight,
  renderLayoutRows,
  splitTimerText,
  useCustomLayout,
} from "./layout.js";

export { placeLeftRight } from "./layout.js";

let currentCtx: ExtensionContext | null = null;
let tuiRef: { requestRender?: () => void } | null = null;
let getSettings: () => UiThemeSettings = () => ({ ...DEFAULTS });

export function setFooterDeps(opts: {
  getSettings: () => UiThemeSettings;
}): void {
  getSettings = opts.getSettings;
}

export function setFooterCtx(ctx: ExtensionContext | null): void {
  currentCtx = ctx;
}

export function requestFooterRender(): void {
  try {
    tuiRef?.requestRender?.();
  } catch {
    // ignore
  }
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Drop the trailing ` |` that setStatusBlock appends. Inner pipes stay. */
export function stripStatusSuffix(text: string): string {
  return text.replace(/\s*\|\s*$/, "").trim();
}

/** Join already-stripped status blocks. Empty sep = tight concat. */
export function joinStatusBlocks(texts: string[], sep: string): string {
  return texts.filter((t) => t.length > 0).join(sep);
}

interface StatusBlock {
  key: string;
  text: string;
}

function collectStatuses(footerData: any): { rate: string; turn: string; timer: string; blocks: StatusBlock[] } {
  const map = footerData?.getExtensionStatuses?.() ?? new Map();
  const entries = Array.from(map.entries() as Iterable<[string, string]>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  let rate = "";
  let turn = "";
  let timer = "";
  const blocks: StatusBlock[] = [];
  for (const [key, text] of entries) {
    const clean = stripStatusSuffix(sanitizeStatus(String(text ?? "")));
    if (!clean) continue;
    if (key === RATE_STATUS_KEY) {
      rate = clean;
      continue;
    }
    if (key === "zz-turn") turn = clean;
    if (key === "_") timer = clean;
    blocks.push({ key, text: clean });
  }
  return { rate, turn, timer, blocks };
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolved = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolved);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return rel === "" ? "~" : `~${sep}${rel}`;
  }
  return cwd;
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hitRate: number | undefined;
}

function usageTotals(ctx: ExtensionContext): Totals {
  const t: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hitRate: undefined };
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      const e = entry as any;
      let u: any;
      if (e.type === "message" && e.message?.usage) {
        u = e.message.usage;
        if (e.message.role === "assistant") {
          const pt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          if (pt > 0) t.hitRate = ((u.cacheRead ?? 0) / pt) * 100;
        }
      } else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
        u = e.usage;
      }
      if (u) {
        t.input += u.input ?? 0;
        t.output += u.output ?? 0;
        t.cacheRead += u.cacheRead ?? 0;
        t.cacheWrite += u.cacheWrite ?? 0;
        t.cost += u.cost?.total ?? 0;
      }
    }
  } catch {
    // totals stay zero
  }
  return t;
}

function formatClock(d = new Date()): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function paintCwd(theme: ThemeLike, ctx: ExtensionContext | null): string {
  if (!ctx) return "";
  return seg(theme, "dim", formatCwd(ctx.cwd));
}

function paintSession(theme: ThemeLike, ctx: ExtensionContext | null): string {
  if (!ctx) return "";
  const name = ctx.sessionManager.getSessionName?.();
  return name ? seg(theme, "dim", name) : "";
}

function paintCwdSession(theme: ThemeLike, ctx: ExtensionContext | null): string {
  if (!ctx) return "";
  let left = seg(theme, "dim", formatCwd(ctx.cwd));
  const name = ctx.sessionManager.getSessionName?.();
  if (name) left += seg(theme, "dim", ` • ${name}`);
  return left;
}

function paintModel(theme: ThemeLike, ctx: ExtensionContext | null, footerData: any): string {
  if (!ctx) return "";
  const m = ctx.model;
  if (!m) return seg(theme, "dim", "no-model");
  const name = m.name || m.id || "no-model";
  let modelPart = seg(theme, "accent", name);
  if (m.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
    modelPart += seg(theme, "dim", ` • ${ctx.thinkingLevel}`);
  }
  const providers = footerData?.getAvailableProviderCount?.() ?? 0;
  return providers > 1 && m.provider
    ? seg(theme, "dim", `(${m.provider}) `) + modelPart
    : modelPart;
}

function paintUsage(theme: ThemeLike, ctx: ExtensionContext | null): string {
  if (!ctx) return "";
  const t = usageTotals(ctx);
  const parts: string[] = [];
  if (t.input) parts.push(seg(theme, "accent", `↑${formatTokens(t.input)}`));
  if (t.output) parts.push(seg(theme, "accent", `↓${formatTokens(t.output)}`));
  if (t.cacheRead) parts.push(seg(theme, "dim", `R${formatTokens(t.cacheRead)}`));
  if (t.cacheWrite) parts.push(seg(theme, "dim", `W${formatTokens(t.cacheWrite)}`));
  if (t.hitRate !== undefined) parts.push(seg(theme, "success", `CH${t.hitRate.toFixed(1)}%`));
  if (t.cost > 0) parts.push(seg(theme, "warning", `$${t.cost.toFixed(3)}`));
  return parts.join(" ");
}

function paintContext(
  theme: ThemeLike,
  ctx: ExtensionContext | null,
  barStyle: UiThemeSettings["barStyle"],
  barLen = 10,
  gap = " ",
): string {
  if (!ctx) return "";
  const cu = ctx.getContextUsage?.();
  if (!cu || !cu.contextWindow) return "";
  const pct = cu.percent;
  const f = pct === null ? 0 : Math.max(0, Math.min(1, pct / 100));
  const pctStr = pct === null ? "  ?.?" : pct.toFixed(1).padStart(5);
  const color = pct === null ? "dim" : pct > 90 ? "error" : pct > 70 ? "warning" : "success";
  return `${bar(theme, f, barLen, barStyle)}${gap}${seg(theme, color, `${pctStr}%/${formatTokens(cu.contextWindow)}`)}`;
}

function fitStatusBlocks(blocks: StatusBlock[], layout: FooterLayout): string[] {
  return blocks.map((b) => {
    const spec = layout.cells[b.key];
    if (!spec || spec.w <= 0) return b.text;
    return fitVisible(b.text, spec.w, spec.align);
  });
}

function buildCellTexts(
  theme: ThemeLike,
  ctx: ExtensionContext | null,
  footerData: any,
  settings: UiThemeSettings,
  statuses: { rate: string; turn: string; timer: string; blocks: StatusBlock[] },
): Record<string, string> {
  const split = splitTimerText(statuses.timer);
  const rateParts = getRateParts();
  const used = consumedStatusKeys(settings.layout.rows);
  const leftover = statuses.blocks.filter((b) => !used.has(b.key));
  const total = split.total || "0:00";
  const last = split.last || "0:00";
  const texts: Record<string, string> = {
    clock: formatClock(),
    cwd: paintCwd(theme, ctx),
    session: paintSession(theme, ctx),
    "cwd-session": paintCwdSession(theme, ctx),
    model: paintModel(theme, ctx, footerData),
    usage: paintUsage(theme, ctx),
    context: paintContext(theme, ctx, settings.barStyle, 8, "  "),
    rate: rateParts.full || statuses.rate,
    "rate-bar": rateParts.bar,
    "rate-num": rateParts.num,
    turn: statuses.turn,
    "zz-turn": statuses.turn,
    "zz-rate": rateParts.full || statuses.rate,
    total,
    last,
    timer: `${total} · ${last}`,
    tools: split.tools || "0 · 0",
    _: statuses.timer,
    status: joinStatusBlocks(
      leftover.map((b) => {
        const spec = settings.layout.cells[b.key];
        if (!spec || spec.w <= 0) return b.text;
        return fitVisible(b.text, spec.w, spec.align);
      }),
      settings.layout.sep || settings.statusSep,
    ),
  };
  for (const b of statuses.blocks) {
    texts[b.key] = b.text;
  }
  return texts;
}

function wrapFrame(lines: string[], w: number, settings: UiThemeSettings): string[] {
  if (!settings.frame) return lines;
  return frameBox(lines, w, {
    colors: frameColorsFromHex(settings.frameBlu, settings.framePur),
    bluHex: settings.frameBlu,
    purHex: settings.framePur,
    style: settings.frameStyle,
    fill: settings.frameFill,
    title: settings.layout.embed ? "" : settings.frameTitle,
    embed: settings.layout.embed,
  });
}

function renderFooter(theme: ThemeLike, width: number, footerData: any): string[] {
  const settings = getSettings();
  const totalW = Math.max(20, width);
  // When framed, content lives between walls (2 cols).
  const w = settings.frame ? Math.max(10, totalW - 2) : totalW;
  const ctx = currentCtx;
  const statuses = collectStatuses(footerData);

  if (useCustomLayout(settings.layout)) {
    const texts = buildCellTexts(theme, ctx, footerData, settings, statuses);
    const lines = renderLayoutRows(settings.layout, texts, w, settings.statusSep);
    return wrapFrame(lines, w, settings);
  }

  const left1 = paintCwdSession(theme, ctx);
  const right1 = paintModel(theme, ctx, footerData);
  const line1 = placeLeftRight(left1, right1, w);

  const usage = paintUsage(theme, ctx);
  const context = paintContext(theme, ctx, settings.barStyle);
  const parts: string[] = [];
  if (usage) parts.push(usage);
  if (context) parts.push(context);
  if (statuses.rate) parts.push(statuses.rate);
  const line2 = padEndVisible(trunc(parts.join(" "), w), w);

  const line3 = padEndVisible(
    trunc(joinStatusBlocks(fitStatusBlocks(statuses.blocks, settings.layout), settings.statusSep), w),
    w,
  );

  return wrapFrame([line1, line2, line3], w, settings);
}

export function installFooter(ctx: ExtensionContext): void {
  if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function") return;
  currentCtx = ctx;
  try {
    ctx.ui.setFooter((tui: any, theme: ThemeLike, footerData: any) => {
      tuiRef = tui;
      return {
        render: (width: number) => renderFooter(theme, width, footerData),
        invalidate: () => {},
      };
    });
    tuiRef = null;
    requestFooterRender();
  } catch {
    // ignore
  }
}

export function restoreBuiltinFooter(ctx: ExtensionContext | null): void {
  tuiRef = null;
  try {
    if (ctx?.hasUI && typeof ctx.ui?.setFooter === "function") {
      ctx.ui.setFooter(undefined);
    }
  } catch {
    // ignore during teardown
  }
}

export function applyFooterFromSettings(ctx: ExtensionContext | null): void {
  if (!ctx?.hasUI) return;
  if (getSettings().footer) installFooter(ctx);
  else restoreBuiltinFooter(ctx);
}
