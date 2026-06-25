import {
  convertIndentToMatchFile,
  normalizeForFuzzyMatch,
  normalizeToLF,
} from "./normalize.js";

export interface TextMatch {
  index: number;
  length: number;
  usedFuzzy: boolean;
}

export function findText(content: string, oldText: string, fromIndex = 0): TextMatch | undefined {
  const exact = content.indexOf(oldText, fromIndex);
  if (exact !== -1) {
    return { index: exact, length: oldText.length, usedFuzzy: false };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  const fuzzyIdx = fuzzyContent.indexOf(fuzzyOld, fromIndex);
  if (fuzzyIdx !== -1) {
    return { index: fuzzyIdx, length: fuzzyOld.length, usedFuzzy: true };
  }

  const indentOld = convertIndentToMatchFile(oldText, content);
  if (indentOld !== undefined) {
    const pos = content.indexOf(indentOld, fromIndex);
    if (pos !== -1) return { index: pos, length: indentOld.length, usedFuzzy: true };
  }

  return undefined;
}

export function findActualString(
  content: string,
  oldText: string,
  offset = 0,
): { index: number; length: number } | undefined {
  const exact = content.indexOf(oldText, offset);
  if (exact !== -1) return { index: exact, length: oldText.length };

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  const fuzzyIdx = fuzzyContent.indexOf(fuzzyOld, offset);
  if (fuzzyIdx !== -1) {
    return { index: fuzzyIdx, length: fuzzyOld.length };
  }

  const indentOld = convertIndentToMatchFile(oldText, content);
  if (indentOld !== undefined) {
    const pos = content.indexOf(indentOld, offset);
    if (pos !== -1) return { index: pos, length: indentOld.length };
  }

  return undefined;
}

export function countOccurrences(content: string, oldText: string, fromIndex = 0): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOld) return 0;
  let count = 0;
  let pos = fromIndex;
  while (true) {
    const idx = fuzzyContent.indexOf(fuzzyOld, pos);
    if (idx === -1) break;
    count++;
    pos = idx + Math.max(1, fuzzyOld.length);
  }
  return count;
}

export function findAllMatches(content: string, oldText: string, fromIndex = 0): TextMatch[] {
  const matches: TextMatch[] = [];
  let pos = fromIndex;
  while (pos < content.length) {
    const m = findText(content, oldText, pos);
    if (!m) break;
    matches.push(m);
    pos = m.index + Math.max(1, m.length);
  }
  return matches;
}

export function pairKey(edit: { oldText: string; newText: string }): string {
  return `${edit.oldText}\0${edit.newText}`;
}

interface Candidate {
  lineNum: number;
  line: string;
  score: number;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = Array(n + 1).fill(0);
  const curr = Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return curr[n];
}

function extractIdentifiers(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)].map((m) => m[0]),
    ),
  ];
}

function identifiersStillInFile(fileContent: string, oldText: string): string[] {
  const ids = extractIdentifiers(oldText);
  return ids.filter((id) => fileContent.includes(id));
}

function findCandidates(fileContent: string, oldText: string, limit = 2): Candidate[] {
  const fileLines = fileContent.split("\n");
  const anchor = (oldText.split("\n")[0] ?? "").trim();
  if (!anchor) return [];

  const words = [...anchor.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g)].map((m) =>
    m[0].toLowerCase(),
  );
  const uniqueWords = [...new Set(words)];

  const scored: Candidate[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    let score = 0;
    if (line.trim() === anchor) score += 100;
    const lower = line.toLowerCase();
    for (const w of uniqueWords) if (lower.includes(w)) score += 10;
    for (let k = 0; k < Math.min(line.length, anchor.length); k++) {
      if (line[k] === anchor[k]) score++;
      else break;
    }
    if (score > 0) scored.push({ lineNum: i + 1, line, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<number>();
  const top: Candidate[] = [];
  for (const s of scored) {
    if (!seen.has(s.lineNum)) {
      seen.add(s.lineNum);
      top.push(s);
    }
    if (top.length >= limit) break;
  }
  return top;
}

function quoteStyleDiffers(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/['"]/g, "");
  return strip(a) === strip(b) && a !== b && /['"]/.test(a + b);
}

function describeIndent(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  const tabs = [...indent].filter((c) => c === "\t").length;
  const spaces = [...indent].filter((c) => c === " ").length;
  const parts: string[] = [];
  if (tabs) parts.push(`${tabs} tab(s)`);
  if (spaces) parts.push(`${spaces} space(s)`);
  return parts.join(" + ") || "none";
}

interface DiffPosition {
  index: number;
  actual: string;
  expected: string;
}

function findFirstDiff(actual: string, expected: string): DiffPosition | undefined {
  const len = Math.min(actual.length, expected.length);
  for (let i = 0; i < len; i++) {
    if (actual[i] !== expected[i]) {
      return { index: i, actual: actual[i], expected: expected[i] };
    }
  }
  if (actual.length !== expected.length) {
    const idx = len;
    return actual.length > expected.length
      ? { index: idx, actual: actual[idx] ?? "", expected: "<end>" }
      : { index: idx, actual: "<end>", expected: expected[idx] ?? "" };
  }
  return undefined;
}

function wordAt(text: string, index: number): { word: string; start: number; end: number } {
  let start = index;
  while (start > 0 && /\S/.test(text[start - 1] ?? "")) start--;
  let end = index;
  while (end < text.length && /\S/.test(text[end] ?? "")) end++;
  return { word: text.slice(start, end), start, end };
}

function describeFirstWordDiff(actual: string, expected: string): string | undefined {
  const diff = findFirstDiff(actual, expected);
  if (!diff) return undefined;

  const expectedWord = wordAt(expected, diff.index);
  const actualWord = wordAt(actual, diff.index);
  const contextRadius = 40;
  const ctxStart = Math.max(0, diff.index - contextRadius);
  const ctxEnd = Math.min(actual.length, diff.index + contextRadius);
  const actualSnippet = actual.slice(ctxStart, ctxEnd);
  const expectedSnippet = expected.slice(ctxStart, ctxEnd);

  let msg = `first difference at character ${diff.index}: expected "${expectedWord.word}", got "${actualWord.word}"`;
  if (actualSnippet.length > 80 || expectedSnippet.length > 80) {
    msg += ` (around: file "${actualSnippet}", oldText "${expectedSnippet}")`;
  }
  return msg;
}

function diagnoseDetailedMismatch(
  fileContent: string,
  oldText: string,
  anchorLine: string,
): string | undefined {
  const fileLines = fileContent.split("\n");
  const anchorTrim = anchorLine.trim();
  const anchorIdx = fileLines.findIndex((l) => l.trim() === anchorTrim);
  if (anchorIdx === -1) return undefined;

  const oldLines = oldText.split("\n");
  const hints: string[] = [];

  // Compare line-by-line for a few lines
  for (let i = 0; i < Math.min(oldLines.length, fileLines.length - anchorIdx); i++) {
    const oldLine = oldLines[i];
    const fileLine = fileLines[anchorIdx + i];
    if (oldLine === fileLine) continue;

    if (oldLine.trim() === fileLine.trim()) {
      hints.push(
        `indentation differs on line ${anchorIdx + i + 1}: you sent ${describeIndent(oldLine)}, file has ${describeIndent(fileLine)}`,
      );
    } else if (oldLine.toLowerCase() === fileLine.toLowerCase()) {
      hints.push(`case mismatch on line ${anchorIdx + i + 1}`);
    } else if (quoteStyleDiffers(oldLine, fileLine)) {
      hints.push(`quote style differs on line ${anchorIdx + i + 1}`);
    }
  }

  if (oldLines.length > fileLines.length - anchorIdx) {
    hints.push(`oldText extends beyond the file block (too many lines)`);
  }

  if (oldText.endsWith("\n") && !fileContent.slice(fileContent.indexOf(fileLines[anchorIdx]) + fileLines[anchorIdx].length).startsWith("\n")) {
    hints.push("oldText expects a trailing newline that is not present");
  }

  return hints.length > 0 ? `Hint: ${hints.join("; ")}.` : undefined;
}

export function buildMismatchHint(
  fileContent: string,
  oldText: string,
  newText?: string,
): string {
  const candidates = findCandidates(fileContent, oldText, 1);
  const survivingIds = identifiersStillInFile(fileContent, oldText);

  const isDeletion = newText === "";

  if (candidates.length === 0) {
    if (isDeletion) {
      return (
        "delete failed — oldText block not found. Include the full block to remove with exact " +
        "indentation and trailing newlines; re-read the file and copy verbatim."
      );
    }
    if (survivingIds.length > 0) {
      const sample = survivingIds.slice(0, 3).join(", ");
      return (
        `oldText block not found, but identifiers (${sample}) still appear in the file — ` +
        "layout may have changed after a prior edit; re-read the file and rebuild oldText from current contents."
      );
    }
    return "oldText not found in file — check spelling, indentation, and line endings.";
  }

  const anchor = (oldText.split("\n")[0] ?? "").trim();
  const best = candidates[0];
  const bestTrimmed = best.line.trim();
  const distance = levenshtein(anchor, bestTrimmed);
  const close = distance <= Math.max(2, Math.floor(best.line.length * 0.2));

  const parts: string[] = [];
  if (close && anchor !== bestTrimmed) {
    parts.push(`did you mean line ${best.lineNum}: \`${best.line}\``);
  } else {
    parts.push(`closest: line ${best.lineNum}: \`${best.line}\``);
  }

  const firstDiff = describeFirstWordDiff(best.line, oldText.split("\n")[0] ?? "");
  if (firstDiff) parts.push(firstDiff);

  if (anchor === bestTrimmed) {
    const detailed = diagnoseDetailedMismatch(fileContent, oldText, best.line);
    if (detailed) parts.push(detailed);
  }

  if (close) {
    if (quoteStyleDiffers(anchor, bestTrimmed)) {
      parts.push(`quote style differs on line ${best.lineNum} (' vs ")`);
    }
    if (oldText.toLowerCase() === best.line.toLowerCase() && oldText !== best.line) {
      parts.push(`case mismatch on line ${best.lineNum}`);
    }
    if (oldText.trimStart() === best.line.trimStart() && oldText !== best.line) {
      parts.push(
        `indentation differs on line ${best.lineNum}: you sent ${describeIndent(oldText)}, file has ${describeIndent(best.line)}`,
      );
    }
    if (/[\u2018\u2019\u201C\u201D]/.test(oldText)) parts.push("curly quotes in oldText");
    if (oldText !== oldText.trimEnd()) parts.push("trailing whitespace in oldText");
  } else if (survivingIds.length > 0) {
    parts.push(
      "block may have moved after a prior edit; re-read the file (read:section or read:grep), copy the exact current block, then retry with rebuilt oldText",
    );
  }

  return parts.length > 0 ? parts.join("; ") + "." : "oldText not found — re-read the file for exact text.";
}

export function normalizeEditText(text: string): string {
  return normalizeToLF(text);
}
