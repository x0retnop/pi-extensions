/**
 * Shared TUI paint helpers for chrome (footer frame, bars, ANSI-safe width).
 * Used by ui-theme and other extensions; keep free of extension state.
 */

export const RESET = "\x1b[0m";
/** Blue half of the B2 chrome frame (matches banner arts vibe). */
export const FRAME_BLU = "\x1b[38;2;100;150;255m";
/** Purple half of the B2 chrome frame. */
export const FRAME_PUR = "\x1b[38;2;180;100;255m";

export const paint = (code: string, s: string) => `${code}${s}${RESET}`;

export type FrameStyleId = "sharp" | "rounded" | "double" | "heavy" | "ascii" | "block";
export type FrameFillId = "split" | "solid" | "fade";
export type BarStyleId = "block" | "density" | "hash" | "dot" | "rise";

export const FRAME_STYLE_IDS: readonly FrameStyleId[] = [
  "sharp",
  "rounded",
  "double",
  "heavy",
  "ascii",
  "block",
];
export const FRAME_FILL_IDS: readonly FrameFillId[] = ["split", "solid", "fade"];
export const BAR_STYLE_IDS: readonly BarStyleId[] = ["block", "density", "hash", "dot", "rise"];

export interface FrameGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  vl: string;
  vr: string;
}

/** Single-column box glyphs. Default `sharp` is the original B2 frame. */
export const FRAME_STYLES: Record<FrameStyleId, FrameGlyphs> = {
  sharp: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", vl: "│", vr: "│" },
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", vl: "│", vr: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", vl: "║", vr: "║" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", vl: "┃", vr: "┃" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", vl: "|", vr: "|" },
  block: { tl: "▛", tr: "▜", bl: "▙", br: "▟", h: "▀", vl: "▌", vr: "▐" },
};

export interface BarGlyphs {
  fill: string;
  empty: string;
}

export const BAR_STYLES: Record<BarStyleId, BarGlyphs> = {
  block: { fill: "█", empty: "░" },
  density: { fill: "█", empty: "░" },
  hash: { fill: "#", empty: "-" },
  dot: { fill: "●", empty: "○" },
  rise: { fill: "█", empty: " " },
};

/** 8-step scale for `rise` bars (context + tok/s). Position i lights glyphs[i]. */
export const RISE_GLYPHS = "▁▂▃▅▆▇█▓";

export function isFrameStyle(v: unknown): v is FrameStyleId {
  return typeof v === "string" && (FRAME_STYLE_IDS as readonly string[]).includes(v);
}

export function isFrameFill(v: unknown): v is FrameFillId {
  return typeof v === "string" && (FRAME_FILL_IDS as readonly string[]).includes(v);
}

export function isBarStyle(v: unknown): v is BarStyleId {
  return typeof v === "string" && (BAR_STYLE_IDS as readonly string[]).includes(v);
}

export function normalizeFrameStyle(v: unknown, fallback: FrameStyleId = "sharp"): FrameStyleId {
  return isFrameStyle(v) ? v : fallback;
}

export function normalizeFrameFill(v: unknown, fallback: FrameFillId = "split"): FrameFillId {
  return isFrameFill(v) ? v : fallback;
}

export function normalizeBarStyle(v: unknown, fallback: BarStyleId = "block"): BarStyleId {
  return isBarStyle(v) ? v : fallback;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHexRgb(hex: string): Rgb | null {
  let h = (hex ?? "").trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToFgAnsi(c: Rgb): string {
  return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

/** `#RRGGBB` / `#RGB` → 24-bit FG ANSI. Invalid → fallback ANSI (already coded). */
export function hexToFgAnsi(hex: string, fallbackAnsi: string = FRAME_BLU): string {
  const rgb = parseHexRgb(hex);
  return rgb ? rgbToFgAnsi(rgb) : fallbackAnsi;
}

export function frameColorsFromHex(bluHex: string, purHex: string): FrameColors {
  return {
    blu: hexToFgAnsi(bluHex, FRAME_BLU),
    pur: hexToFgAnsi(purHex, FRAME_PUR),
  };
}

export interface ThemeLike {
  fg(color: string, text: string): string;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible (ANSI-stripped) length. Handles SGR + 24-bit color codes. */
export function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate by visible chars, preserving ANSI sequences intact. */
export function trunc(s: string, max: number): string {
  if (visibleLen(s) <= max) return s;
  let out = "";
  let visible = 0;
  let inAnsi = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x1b) {
      inAnsi = true;
      out += s[i];
      continue;
    }
    if (inAnsi) {
      out += s[i];
      if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a)) inAnsi = false;
      continue;
    }
    if (visible >= max) break;
    out += s[i];
    visible++;
  }
  return out;
}

export function padEndVisible(s: string, n: number): string {
  const pad = n - visibleLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function padStartVisible(s: string, n: number): string {
  const pad = n - visibleLen(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/** Truncate or pad to exactly `n` visible chars. `n <= 0` leaves the string as-is. */
export function fitVisible(s: string, n: number, align: "left" | "right" = "left"): string {
  if (n <= 0) return s;
  const t = trunc(s, n);
  return align === "right" ? padStartVisible(t, n) : padEndVisible(t, n);
}

export function seg(theme: ThemeLike, key: string, s: string): string {
  return theme.fg(key, s);
}

export interface BarParts {
  hot: string;
  cold: string;
}

/**
 * Uncolored bar halves. `density` tapers █▓▒ into ░ at the leading edge;
 * `rise` lights a unique step of ▁▂▃▅▆▇█▓ per cell; others are fill/empty.
 */
export function barParts(frac: number, len: number, style: BarStyleId = "block"): BarParts {
  const n = Math.max(0, Math.floor(len));
  const f = Math.max(0, Math.min(1, frac));
  const filled = Math.round(f * n);
  if (style === "density") {
    let hot = "";
    let cold = "";
    for (let i = 0; i < n; i++) {
      const remain = filled - i;
      if (remain >= 3) hot += "█";
      else if (remain === 2) hot += "▓";
      else if (remain === 1) hot += "▒";
      else cold += "░";
    }
    return { hot, cold };
  }
  if (style === "rise") {
    const steps = RISE_GLYPHS.length;
    let hot = "";
    let cold = "";
    for (let i = 0; i < n; i++) {
      const gi = n <= 1 ? steps - 1 : Math.round((i / (n - 1)) * (steps - 1));
      if (i < filled) hot += RISE_GLYPHS[gi] ?? "█";
      else cold += " ";
    }
    return { hot, cold };
  }
  const g = BAR_STYLES[style] ?? BAR_STYLES.block;
  return { hot: g.fill.repeat(filled), cold: g.empty.repeat(n - filled) };
}

/** Filled bar: accent + dim. */
export function bar(
  theme: ThemeLike,
  frac: number,
  len: number,
  style: BarStyleId = "block",
): string {
  const { hot, cold } = barParts(frac, len, style);
  return seg(theme, "accent", hot) + seg(theme, "dim", cold);
}

export interface FrameColors {
  blu: string;
  pur: string;
}

export interface FrameBoxOpts {
  colors?: FrameColors;
  style?: FrameStyleId;
  fill?: FrameFillId;
  /** Hex used by `fade` (and as source for ANSI when `colors` omitted). */
  bluHex?: string;
  purHex?: string;
  title?: string;
  /** First/last content lines sit in the corner rows (no extra ─ rules). */
  embed?: boolean;
}

const DEFAULT_FRAME: FrameColors = { blu: FRAME_BLU, pur: FRAME_PUR };

function resolveColors(opts: FrameBoxOpts): { colors: FrameColors; bluRgb: Rgb; purRgb: Rgb } {
  const bluRgb = parseHexRgb(opts.bluHex ?? "") ?? { r: 100, g: 150, b: 255 };
  const purRgb = parseHexRgb(opts.purHex ?? "") ?? { r: 180, g: 100, b: 255 };
  const colors =
    opts.colors ??
    (opts.bluHex || opts.purHex
      ? { blu: rgbToFgAnsi(bluRgb), pur: rgbToFgAnsi(purRgb) }
      : DEFAULT_FRAME);
  return { colors, bluRgb, purRgb };
}

/** Horizontal run of `ch`, colored by fill mode. */
export function gradientRule(
  n: number,
  blu = FRAME_BLU,
  pur = FRAME_PUR,
  fill: FrameFillId = "split",
  ch = "─",
  bluRgb?: Rgb,
  purRgb?: Rgb,
): string {
  const count = Math.max(0, n);
  if (count === 0) return "";
  if (fill === "solid") return paint(blu, ch.repeat(count));
  if (fill === "fade" && bluRgb && purRgb) {
    if (count === 1) return paint(blu, ch);
    let out = "";
    for (let i = 0; i < count; i++) {
      out += paint(rgbToFgAnsi(lerpRgb(bluRgb, purRgb, i / (count - 1))), ch);
    }
    return out;
  }
  const left = Math.max(0, Math.floor(count / 2));
  const right = Math.max(0, count - left);
  return paint(blu, ch.repeat(left)) + paint(pur, ch.repeat(right));
}

function titleLabel(raw: string | undefined, innerW: number): string {
  const t = (raw ?? "").replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
  if (!t || innerW < 3) return "";
  // ` X ` wrapper + at least one rule char after.
  const maxInner = Math.max(1, innerW - 3);
  return ` ${trunc(t, maxInner)} `;
}

/** Wrap content lines in a box (top/bottom rule + side walls). */
export function frameBox(lines: string[], innerW: number, opts: FrameBoxOpts = {}): string[] {
  const style = normalizeFrameStyle(opts.style);
  const fill = normalizeFrameFill(opts.fill);
  const g = FRAME_STYLES[style];
  const { colors, bluRgb, purRgb } = resolveColors(opts);
  const { blu, pur } = colors;
  const right = fill === "solid" ? blu : pur;
  const rule = (n: number) => gradientRule(n, blu, pur, fill, g.h, bluRgb, purRgb);
  const wall = (s: string) => paint(blu, g.vl) + s + paint(right, g.vr);
  const fit = (s: string) => padEndVisible(trunc(s, innerW), innerW);

  if (opts.embed && lines.length > 0) {
    const top = paint(blu, g.tl) + fit(lines[0] ?? "") + paint(right, g.tr);
    if (lines.length === 1) return [top];
    // Middle rows: spaces instead of walls so columns line up with corner content.
    const mid = lines.slice(1, -1).map((l) => ` ${fit(l)} `);
    const bot = paint(blu, g.bl) + fit(lines[lines.length - 1] ?? "") + paint(right, g.br);
    return [top, ...mid, bot];
  }

  const body = lines.map((l) => wall(fit(l)));
  const label = titleLabel(opts.title, innerW);
  const top =
    paint(blu, g.tl) +
    (label ? paint(blu, label) + rule(Math.max(0, innerW - visibleLen(label))) : rule(innerW)) +
    paint(right, g.tr);
  const bot = paint(blu, g.bl) + rule(innerW) + paint(right, g.br);
  return [top, ...body, bot];
}
