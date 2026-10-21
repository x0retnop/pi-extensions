/**
 * Footer cell layout: named slots, fixed widths, left/right rows.
 * Stock 3-line chrome stays in footer.ts when layout.rows is empty.
 */

import { fitVisible, padEndVisible, stripAnsi, trunc, visibleLen } from "./paint.js";
import {
  type FooterCellSpec,
  type FooterLayout,
  type FooterRowSpec,
  hasCustomRows,
} from "./settings.js";

/** Tokens matching this are cell ids (builtin or setStatus key). Anything else is a literal sep. */
const CELL_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const BUILTIN_CELLS = new Set([
  "clock",
  "cwd",
  "session",
  "cwd-session",
  "model",
  "usage",
  "context",
  "rate",
  "rate-bar",
  "rate-num",
  "timer",
  "total",
  "last",
  "tools",
  "turn",
  "status",
]);

export function isCellId(tok: string): boolean {
  return CELL_ID_RE.test(tok);
}

export function cellSpec(layout: FooterLayout, id: string): FooterCellSpec {
  return layout.cells[id] ?? { w: 0, align: "left" };
}

/**
 * a-rewind `_` status → total / last / tools.
 * Strips ANSI first: the yellow wrap sits between ` ` and `|` (`0:00 \\x1b[0m| 0 · 0`).
 */
export function splitTimerText(text: string): { total: string; last: string; timer: string; tools: string } {
  const plain = stripAnsi(text).replace(/ +/g, " ").trim();
  let pipe = plain.indexOf(" | ");
  let sepLen = 3;
  if (pipe < 0) {
    pipe = plain.indexOf("|");
    sepLen = 1;
  }
  const time = (pipe >= 0 ? plain.slice(0, pipe) : plain).trim();
  const tools = pipe >= 0 ? plain.slice(pipe + sepLen).trim() : "";
  const dot = time.indexOf(" · ");
  if (dot >= 0) {
    const total = time.slice(0, dot).trim();
    const last = time.slice(dot + 3).trim();
    return { total, last, timer: time, tools };
  }
  return { total: time, last: "", timer: time, tools };
}

/** Status keys consumed by a cell id in the rows (so they are not leftover). */
export function consumedStatusKeys(rows: FooterRowSpec[]): Set<string> {
  const used = new Set<string>();
  for (const row of rows) {
    for (const tok of [...row.left, ...row.right]) {
      if (!isCellId(tok) || tok === "status") continue;
      if (tok === "timer" || tok === "tools" || tok === "total" || tok === "last" || tok === "_") used.add("_");
      else if (tok === "rate" || tok === "zz-rate" || tok === "rate-bar" || tok === "rate-num") used.add("zz-rate");
      else if (tok === "turn" || tok === "zz-turn") used.add("zz-turn");
      else if (BUILTIN_CELLS.has(tok)) continue;
      else used.add(tok);
    }
  }
  return used;
}

/** Left + right with space pad. Truncate right first, then left. */
export function placeLeftRight(left: string, right: string, w: number, minPad = 2): string {
  const lw = visibleLen(left);
  const rw = visibleLen(right);
  if (!right) return padEndVisible(trunc(left, w), w);
  if (lw + minPad + rw <= w) {
    return left + " ".repeat(w - lw - rw) + right;
  }
  const availRight = Math.max(0, w - lw - minPad);
  if (availRight > 0) {
    return padEndVisible(left + " ".repeat(minPad) + trunc(right, availRight), w);
  }
  return padEndVisible(trunc(left, w), w);
}

function fitCell(text: string, spec: FooterCellSpec): string {
  if (spec.w > 0) return fitVisible(text, spec.w, spec.align);
  return text;
}

/** Join cell ids / literals. Empty shrink-wrap cells drop out; fixed-width empties keep their slot. */
export function renderFlow(
  tokens: string[],
  texts: Record<string, string>,
  layout: FooterLayout,
  sep: string,
): string {
  const out: string[] = [];
  let pendingLit: string | undefined;
  for (const tok of tokens) {
    if (!isCellId(tok)) {
      pendingLit = /\s/.test(tok) ? tok : ` ${tok} `;
      continue;
    }
    const spec = cellSpec(layout, tok);
    const fitted = fitCell(texts[tok] ?? "", spec);
    if (visibleLen(fitted) === 0 && spec.w <= 0) continue;
    if (out.length > 0) out.push(pendingLit !== undefined ? pendingLit : sep);
    pendingLit = undefined;
    out.push(fitted);
  }
  if (pendingLit !== undefined && out.length > 0) out.push(pendingLit);
  return out.join("");
}

export function renderLayoutRows(
  layout: FooterLayout,
  texts: Record<string, string>,
  width: number,
  fallbackSep: string,
): string[] {
  const sep = layout.sep || fallbackSep;
  const pad = Math.max(0, layout.pad);
  const inner = Math.max(1, width - 2 * pad);
  const gutter = pad > 0 ? " ".repeat(pad) : "";
  return layout.rows.map((row) => {
    const left = renderFlow(row.left, texts, layout, sep);
    const right = renderFlow(row.right, texts, layout, sep);
    return gutter + placeLeftRight(left, right, inner) + gutter;
  });
}

export function useCustomLayout(layout: FooterLayout): boolean {
  return hasCustomRows(layout);
}
