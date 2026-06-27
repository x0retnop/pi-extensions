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

function resolvePath(args: Record<string, unknown>): string | undefined {
  return typeof args.path === "string" && args.path ? args.path : undefined;
}

function editCount(args: Record<string, unknown>): number {
  if (Array.isArray(args.edits)) return args.edits.length;
  return 1;
}

function insertLine(args: Record<string, unknown>): number | undefined {
  return typeof args.insert_line === "number" ? args.insert_line : undefined;
}

function hasReplaceAll(args: Record<string, unknown>): boolean {
  if (args.replace_all === true) return true;
  if (Array.isArray(args.edits)) {
    return args.edits.some(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).replace_all === true,
    );
  }
  return false;
}

export function formatCallHeader(name: string, args: Record<string, unknown>, theme: any): string {
  const path = resolvePath(args);
  const target = path ? shortenPath(path) : "...";
  const count = editCount(args);
  const line = insertLine(args);
  const suffix = hasReplaceAll(args) ? ", replace_all" : "";
  const countLabel = name === "multi_edit" ? `(${count}${suffix})` : "";
  const lineLabel = name === "insert" && line !== undefined ? `(line ${line})` : "";
  return (
    `${theme.fg("toolTitle", theme.bold(name))} ` +
    `${theme.fg("accent", target)} ` +
    `${theme.fg("dim", countLabel)} ` +
    `${theme.fg("dim", lineLabel)}`
  ).trim();
}

export function makeTextComponent(getLines: (width: number) => string[]) {
  return {
    render(width: number): string[] {
      return getLines(width).map((l) => safeTruncate(l, width));
    },
    invalidate() {},
  };
}
