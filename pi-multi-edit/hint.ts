import { normalizeEditString } from "./match.js";

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function lineContent(content: string, line: number): string | undefined {
  const lines = content.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return undefined;
  return lines[idx];
}

/**
 * Find the position in content where oldString is most likely intended to match.
 * Returns a line-based hint when a fuzzy match exists, or undefined.
 */
export function findClosestLineHint(content: string, oldString: string): number | undefined {
  const normalizedContent = normalizeEditString(content);
  const normalizedOld = normalizeEditString(oldString);

  // Prefer exact match if any.
  const exactIdx = normalizedContent.indexOf(normalizedOld);
  if (exactIdx !== -1) {
    return lineAt(normalizedContent, exactIdx);
  }

  // Fuzzy fallback.
  const fuzzyContent = content
    .normalize("NFKC")
    .split("\n")
    .map((l) => l.trimEnd().replace(/\s+/g, " "))
    .join("\n");
  const fuzzyOld = oldString
    .normalize("NFKC")
    .split("\n")
    .map((l) => l.trimEnd().replace(/\s+/g, " "))
    .join("\n");
  const fuzzyIdx = fuzzyContent.indexOf(fuzzyOld);
  if (fuzzyIdx !== -1) {
    return lineAt(fuzzyContent, fuzzyIdx);
  }

  return undefined;
}

/**
 * Build a one-line hint showing the closest line content, truncated safely.
 */
export function formatLineHint(content: string, line: number): string {
  const text = lineContent(content, line);
  if (text === undefined) return "";
  const trimmed = text.trim();
  const max = 80;
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}
