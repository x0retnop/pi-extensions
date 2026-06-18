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

export function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
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

export function findAllMatches(content: string, oldText: string): TextMatch[] {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOld) return [];

  const matches: TextMatch[] = [];
  let pos = 0;
  while (pos < fuzzyContent.length) {
    const m = findText(fuzzyContent, fuzzyOld, pos);
    if (!m) break;
    matches.push(m);
    pos = m.index + Math.max(1, m.length);
  }
  return matches;
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
    if (survivingIds.length > 0) {
      parts.push("block may have moved — re-read the file if a prior edit restructured this section");
    }
  }

  if (close) {
    if (quoteStyleDiffers(anchor, bestTrimmed)) {
      parts.push(`quote style differs on line ${best.lineNum} (' vs ")`);
    }
    if (oldText.toLowerCase() === best.line.toLowerCase() && oldText !== best.line) {
      parts.push(`case mismatch on line ${best.lineNum}`);
    }
    if (oldText.trimStart() === best.line.trimStart() && oldText !== best.line) {
      parts.push(`indentation differs on line ${best.lineNum}`);
    }
    if (/[\u2018\u2019\u201C\u201D]/.test(oldText)) parts.push("curly quotes in oldText");
    if (oldText !== oldText.trimEnd()) parts.push("trailing whitespace in oldText");
  }

  return parts.length > 0 ? parts.join("; ") + "." : "oldText not found — re-read the file for exact text.";
}

export function normalizeEditText(text: string): string {
  return normalizeToLF(text);
}