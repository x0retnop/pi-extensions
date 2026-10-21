import { normalizeForFuzzyMatch, normalizeToLF } from "./normalize.js";

export interface TextMatch {
  index: number;
  length: number;
  usedFuzzy: boolean;
}

/**
 * Find oldString in content. Exact match is preferred.
 *
 * Fuzzy fallback searches the normalized content, but every candidate is
 * verified against the ORIGINAL bytes before it is returned: the slice at
 * the candidate index must normalize back to fuzzyOld. Normalization trims
 * trailing whitespace and can collapse characters (NFKC) anywhere in the
 * file, which shifts indexes between normalized and original content — an
 * unverified index would slice the wrong span and silently corrupt the
 * file. Unverifiable candidates are skipped, so the worst case is a safe
 * NOT_FOUND (the agent re-reads and retries with verbatim text that then
 * exact-matches), never a wrong write.
 */
export function findText(content: string, oldString: string, fromIndex = 0): TextMatch | undefined {
  const exact = content.indexOf(oldString, fromIndex);
  if (exact !== -1) {
    return { index: exact, length: oldString.length, usedFuzzy: false };
  }

  const fuzzyOld = normalizeForFuzzyMatch(oldString);
  if (!fuzzyOld || fuzzyOld.length !== oldString.length) {
    // Length-changing normalization of oldString itself (NFKC collapse,
    // trimmed edges) can never produce a safe slice of the original.
    return undefined;
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  let pos = 0;
  while (true) {
    const idx = fuzzyContent.indexOf(fuzzyOld, pos);
    if (idx === -1) return undefined;
    pos = idx + 1;
    if (idx < fromIndex) continue;
    const slice = content.slice(idx, idx + oldString.length);
    if (slice.length === oldString.length && normalizeForFuzzyMatch(slice) === fuzzyOld) {
      return { index: idx, length: oldString.length, usedFuzzy: true };
    }
  }
}

export function countOccurrences(content: string, oldString: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldString);
  if (!fuzzyOld) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = fuzzyContent.indexOf(fuzzyOld, pos);
    if (idx === -1) break;
    count++;
    pos = idx + Math.max(1, fuzzyOld.length);
  }
  return count;
}

export function normalizeEditString(text: string): string {
  return normalizeToLF(text);
}

/** Line number (1-indexed) of the first exact or fuzzy occurrence. */
export function findFirstOccurrenceLine(content: string, oldString: string): number | undefined {
  const m = findText(content, oldString, 0);
  if (!m) return undefined;
  const before = content.slice(0, m.index);
  return before.split("\n").length;
}

/** Line numbers (1-indexed) of all fuzzy occurrences, capped. */
export function findOccurrenceLines(content: string, oldString: string, cap = 5): number[] {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldString);
  if (!fuzzyOld) return [];
  const lines: number[] = [];
  let pos = 0;
  while (lines.length < cap) {
    const idx = fuzzyContent.indexOf(fuzzyOld, pos);
    if (idx === -1) break;
    lines.push(fuzzyContent.slice(0, idx).split("\n").length);
    pos = idx + Math.max(1, fuzzyOld.length);
  }
  return lines;
}
