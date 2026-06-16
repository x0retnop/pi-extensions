/** BOM, line endings, and fuzzy normalization (aligned with Pi native edit-diff). */

export function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1) return "\n";
  if (crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function detectIndentUnit(content: string): "\t" | number | null {
  const lines = content.split("\n");
  const spaceIndents: number[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed === line) continue;
    if (line[0] === "\t") return "\t";
    const spaces = line.length - trimmed.length;
    if (spaces > 0) spaceIndents.push(spaces);
  }

  if (spaceIndents.length === 0) return null;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const unit = spaceIndents.reduce(gcd);
  return unit >= 2 ? unit : null;
}

function detectTabWidth(content: string): number {
  const lines = content.split("\n");
  const counts = new Map<number, number>();

  for (const line of lines) {
    const m = line.match(/^(\t+)( +)/);
    if (m) {
      for (const w of [2, 4, 8]) {
        if (m[2].length < w) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  }

  if (counts.size > 0) {
    let best = 2;
    let bestCount = 0;
    for (const [w, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        best = w;
      }
    }
    return best;
  }

  const spaceIndents: number[] = [];
  for (const line of lines) {
    const m = line.match(/^( +)/);
    if (m && !line.includes("\t")) spaceIndents.push(m[1].length);
  }
  if (spaceIndents.length > 0) {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const unit = spaceIndents.reduce(gcd);
    if (unit >= 2) return unit;
  }
  return 2;
}

function convertIndent(
  s: string,
  from: "\t" | number,
  to: "\t" | number,
  tabWidth: number,
): string {
  return s
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const indent = line.slice(0, line.length - trimmed.length);
      if (!indent) return line;

      let depth = 0;
      let i = 0;
      while (i < indent.length) {
        if (indent[i] === "\t") {
          depth++;
          i++;
        } else {
          let spaces = 0;
          while (i < indent.length && indent[i] === " ") spaces++, i++;
          const unit = from === "\t" ? tabWidth : (from as number);
          depth += Math.floor(spaces / unit);
        }
      }

      return to === "\t"
        ? "\t".repeat(depth) + trimmed
        : " ".repeat(depth * (to as number)) + trimmed;
    })
    .join("\n");
}

export function convertIndentToMatchFile(oldText: string, fileContent: string): string | undefined {
  const fileStyle = detectIndentUnit(fileContent);
  const oldStyle = detectIndentUnit(oldText);
  if (!fileStyle || !oldStyle || fileStyle === oldStyle) return undefined;

  const tabWidth =
    fileStyle === "\t" || oldStyle === "\t" ? detectTabWidth(fileContent) : 2;
  const converted = convertIndent(oldText, oldStyle, fileStyle, tabWidth);
  return converted === oldText ? undefined : converted;
}