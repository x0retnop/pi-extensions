import { resolvePathFromRecord } from "./params.js";
import type { ChangeStats, EditMode } from "./types.js";

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1000) return 1;
  if (cp >= 0x2E80 && cp <= 0xA4CF) return 2;
  if (cp >= 0xAC00 && cp <= 0xD7AF) return 2;
  if (cp >= 0x1100 && cp <= 0x11FF) return 2;
  if (cp >= 0xFF01 && cp <= 0xFF60) return 2;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2;
  if (cp >= 0x1F000 || (cp >= 0x2600 && cp <= 0x27BF)) return 2;
  return 1;
}

export function safeTruncate(str: string, maxWidth: number, suffix = "…"): string {
  if (maxWidth <= 0) return "";
  if (maxWidth <= suffix.length) return suffix.slice(0, maxWidth);
  str = str.replace(/\t/g, " ").replace(/\r/g, "");

  let visible = 0;
  let out = "";
  let inAnsi = false;

  for (let i = 0; i < str.length; ) {
    const code = str.charCodeAt(i);
    if (code === 0x1b && str.charCodeAt(i + 1) === 0x5b) {
      inAnsi = true;
      out += str[i++];
      continue;
    }
    if (inAnsi) {
      out += str[i];
      if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) inAnsi = false;
      i++;
      continue;
    }

    let ch: string;
    let step: number;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      ch = str.slice(i, i + 2);
      step = 2;
    } else {
      ch = str[i];
      step = 1;
    }

    if (visible + charWidth(ch) > maxWidth - suffix.length) {
      out += suffix;
      break;
    }
    out += ch;
    visible += charWidth(ch);
    i += step;
  }
  return out;
}

function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function collectEditEntries(args: Record<string, unknown>): unknown[] {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length > 0) return edits;
  if (Array.isArray(args.multi) && args.multi.length > 0) return args.multi;
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return [];
}

function resolveMode(args: Record<string, unknown>): EditMode {
  const entries = collectEditEntries(args);
  const topPath = resolvePathFromRecord(args);
  const paths = new Set<string>();
  for (const e of entries) {
    if (e && typeof e === "object") {
      const p = resolvePathFromRecord(e as Record<string, unknown>) ?? topPath;
      if (p) paths.add(p);
    }
  }
  if (paths.size > 1) return "multi";
  if (entries.length > 1) return "batch";
  return "single";
}

function resolveTarget(args: Record<string, unknown>, mode: EditMode): string {
  const entries = collectEditEntries(args);
  const topPath = resolvePathFromRecord(args);

  if (mode === "multi") {
    const paths = new Set<string>();
    for (const e of entries) {
      if (e && typeof e === "object") {
        const p = resolvePathFromRecord(e as Record<string, unknown>) ?? topPath;
        if (p) paths.add(p);
      }
    }
    return paths.size === 1 ? shortenPath([...paths][0]) : `${paths.size} files`;
  }

  if (topPath) return shortenPath(topPath);
  const first = entries[0];
  if (first && typeof first === "object") {
    const p = resolvePathFromRecord(first as Record<string, unknown>);
    if (p) return shortenPath(p);
  }
  return "...";
}

export function formatCallHeader(args: Record<string, unknown>, theme: any): string {
  const mode = resolveMode(args);
  const label = `edit:${mode}`;
  const target = resolveTarget(args, mode);
  const count = Math.max(collectEditEntries(args).length, 1);

  return (
    `${theme.fg("toolTitle", theme.bold(label))} ` +
    `${theme.fg("accent", target)} ` +
    `${theme.fg("dim", `(${count})`)}`
  );
}

function formatStats(stats: ChangeStats | undefined, theme: any): string {
  if (!stats || (stats.added === 0 && stats.removed === 0)) {
    return theme.fg("dim", "done");
  }
  return (
    theme.fg("toolDiffAdded", `+${stats.added}`) +
    theme.fg("dim", " / ") +
    theme.fg("toolDiffRemoved", `-${stats.removed}`)
  );
}

export function formatResultLines(
  result: any,
  context: any,
  theme: any,
  isPartial: boolean,
): string[] {
  if (isPartial) {
    return [theme.fg("dim", "…")];
  }

  if (context?.isError) {
    const text = result?.content?.[0]?.text ?? "failed";
    return text.split("\n").map((line: string) => theme.fg("error", line));
  }

  return [formatStats(result?.details?.stats, theme)];
}

export function makeTextComponent(getLines: (width: number) => string[]) {
  return {
    render(width: number): string[] {
      return getLines(width).map((l) => safeTruncate(l, width));
    },
    invalidate() {},
  };
}