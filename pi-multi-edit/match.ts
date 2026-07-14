import { normalizeForFuzzyMatch, normalizeToLF } from "./normalize.js";

export interface TextMatch {
  index: number;
  length: number;
  usedFuzzy: boolean;
}

export function findText(content: string, oldString: string, fromIndex = 0): TextMatch | undefined {
  const exact = content.indexOf(oldString, fromIndex);
  if (exact !== -1) {
    return { index: exact, length: oldString.length, usedFuzzy: false };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldString);
  const fuzzyIdx = fuzzyContent.indexOf(fuzzyOld, fromIndex);
  if (fuzzyIdx !== -1) {
    return { index: fuzzyIdx, length: fuzzyOld.length, usedFuzzy: true };
  }

  return undefined;
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
