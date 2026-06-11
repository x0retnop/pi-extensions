import { isAbsolute, resolve as resolvePath } from "path";

import { generateDiffString } from "./diff.js";
import type { EditItem, EditResult, Workspace } from "./types.js";

const normalizeCurlyQuotes = (s: string): string =>
  s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');

const trimTrailingPerLine = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");

const MATCH_PASSES: readonly ((s: string) => string)[] = [
  (s) => s,
  normalizeCurlyQuotes,
  trimTrailingPerLine,
];

/* ── Indentation normalization ───────────────────────────────────────── */

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
      const spaces = m[2].length;
      for (const w of [2, 4, 8]) {
        if (spaces < w) {
          counts.set(w, (counts.get(w) || 0) + 1);
        }
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

  // fallback: look at space-only indents
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
  tabWidth = 2,
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
          while (i < indent.length && indent[i] === " ") {
            spaces++;
            i++;
          }
          const unit = from === "\t" ? tabWidth : (from as number);
          depth += Math.floor(spaces / unit);
        }
      }

      if (to === "\t") {
        return "\t".repeat(depth) + trimmed;
      }
      return " ".repeat(depth * (to as number)) + trimmed;
    })
    .join("\n");
}

function normalizeIndentOldText(
  oldText: string,
  content: string,
): string | undefined {
  const fileStyle = detectIndentUnit(content);
  const oldStyle = detectIndentUnit(oldText);
  if (!fileStyle || !oldStyle || fileStyle === oldStyle) return undefined;

  const tabWidth =
    fileStyle === "\t" || oldStyle === "\t"
      ? detectTabWidth(content)
      : 2;
  const converted = convertIndent(oldText, oldStyle, fileStyle, tabWidth);
  return converted === oldText ? undefined : converted;
}

/* ────────────────────────────────────────────────────────────────────── */

export function findActualString(
  content: string,
  oldText: string,
  offset: number,
): { pos: number; actualOldText: string } | undefined {
  const exact = content.indexOf(oldText, offset);
  if (exact !== -1) return { pos: exact, actualOldText: oldText };

  const triedOld = new Set<string>([oldText]);
  const triedContent = new Set<string>([content]);

  for (let i = 1; i < MATCH_PASSES.length; i++) {
    const transform = MATCH_PASSES[i];
    const normOld = transform(oldText);
    const normContent = transform(content);

    if (triedOld.has(normOld) && triedContent.has(normContent)) continue;
    triedOld.add(normOld);
    triedContent.add(normContent);

    const pos = normContent.indexOf(normOld, offset);
    if (pos !== -1) {
      const actualOld = content.slice(pos, pos + normOld.length);
      if (transform(actualOld) === normOld) {
        return { pos, actualOldText: actualOld };
      }
      const match = findByNormalizedLines(content, oldText, offset, transform);
      if (match) return match;
    }
  }

  // Indentation-normalization pass (tabs ↔ spaces)
  const indentConverted = normalizeIndentOldText(oldText, content);
  if (indentConverted !== undefined) {
    const pos = content.indexOf(indentConverted, offset);
    if (pos !== -1) {
      return { pos, actualOldText: indentConverted };
    }
    const match = findByNormalizedLines(content, indentConverted, offset, (s) => s);
    if (match) return match;
  }

  return undefined;
}

function findByNormalizedLines(
  content: string,
  oldText: string,
  offset: number,
  normalize: (s: string) => string,
): { pos: number; actualOldText: string } | undefined {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) return undefined;

  const normOldLines = oldLines.map((l) => normalize(l));

  let charCount = 0;
  let startLine = 0;
  for (let i = 0; i < contentLines.length; i++) {
    if (charCount + contentLines[i].length >= offset) {
      startLine = i;
      break;
    }
    charCount += contentLines[i].length + 1;
  }

  for (let i = startLine; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < normOldLines.length; j++) {
      if (normalize(contentLines[i + j]) !== normOldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      let pos = 0;
      for (let k = 0; k < i; k++) pos += contentLines[k].length + 1;
      const endLine = i + oldLines.length - 1;
      let endPos = 0;
      for (let k = 0; k <= endLine; k++) endPos += contentLines[k].length + 1;
      endPos--;
      if (oldText.endsWith("\n") && endPos + 1 <= content.length) endPos++;
      const actualOldText = content.slice(pos, endPos);
      return { pos, actualOldText };
    }
  }

  return undefined;
}

interface Candidate {
  idx: number;
  line: string;
  score: number;
}

function findTopCandidates(content: string, oldText: string, limit = 2): Candidate[] {
  const fileLines = content.split("\n");
  const oldLines = oldText.split("\n");

  if (oldLines.length === 0 || oldText.trim().length === 0) return [];

  const anchor = oldLines[0];
  const anchorTrimmed = anchor.trim();
  const words = [...anchorTrimmed.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g)].map((m) => m[0].toLowerCase());
  const uniqueWords = [...new Set(words)];

  const scored: Candidate[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    let score = 0;
    if (line.trim() === anchorTrimmed) score += 100;
    const lower = line.toLowerCase();
    for (const w of uniqueWords) if (lower.includes(w)) score += 10;
    for (let k = 0; k < Math.min(line.length, anchor.length); k++) {
      if (line[k] === anchor[k]) score++; else break;
    }
    if (score > 0) scored.push({ idx: i + 1, line, score });
  }

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<number>();
  const top: Candidate[] = [];
  for (const s of scored) {
    if (!seen.has(s.idx)) { seen.add(s.idx); top.push(s); }
    if (top.length >= limit) break;
  }
  return top;
}

function diagnoseMismatch(oldText: string, candidates: Candidate[]): string | undefined {
  const hints: string[] = [];

  if (/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/.test(oldText)) {
    hints.push("curly/smart quotes in oldText");
  }

  if (oldText !== oldText.trimEnd()) {
    hints.push("trailing whitespace in oldText");
  }

  const oldLines = oldText.split("\n");
  if (oldLines.some((l) => l.startsWith("`"))) {
    hints.push("check leading backtick");
  }

  if (oldText.includes("\t")) {
    hints.push("tab characters in oldText");
  }

  if (!oldText.endsWith("\n") && oldText.includes("\n")) {
    hints.push("missing trailing newline");
  } else if (oldText.endsWith("\n") && oldLines.length > 1 && oldLines[oldLines.length - 1] === "") {
    hints.push("extra trailing newline");
  }

  if (candidates.length > 0) {
    const best = candidates[0];
    if (oldText.toLowerCase() === best.line.toLowerCase() && oldText !== best.line) {
      hints.push(`case mismatch on line ${best.idx}`);
    }
    if (oldText.trimStart() === best.line.trimStart() && oldText !== best.line) {
      const oldIndent = oldText.slice(0, oldText.length - oldText.trimStart().length);
      const fileIndent = best.line.slice(0, best.line.length - best.line.trimStart().length);

      const desc = (indent: string) => {
        const tabs = indent.split("").filter((c) => c === "\t").length;
        const spaces = indent.split("").filter((c) => c === " ").length;
        const parts: string[] = [];
        if (tabs) parts.push(`${tabs} tab(s)`);
        if (spaces) parts.push(`${spaces} space(s)`);
        return parts.join(" + ") || "none";
      };

      hints.push(
        `indentation differs on line ${best.idx}: you sent ${desc(oldIndent)}, file has ${desc(fileIndent)}`,
      );
    }
  }

  return hints.length > 0 ? `Hint: ${hints.join("; ")}.` : undefined;
}

function buildSuggestion(content: string, oldText: string): string | undefined {
  const top = findTopCandidates(content, oldText, 2);
  if (top.length === 0) return undefined;

  const indentDesc = (line: string) => {
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);
    if (!indent) return "";
    const tabs = indent.split("").filter((c) => c === "\t").length;
    const spaces = indent.split("").filter((c) => c === " ").length;
    const parts: string[] = [];
    if (tabs) parts.push(`${tabs} tab(s)`);
    if (spaces) parts.push(`${spaces} space(s)`);
    return ` (starts with ${parts.join(" + ")})`;
  };

  return (
    "Did you mean " +
    top.map(({ idx, line }) => `line ${idx}: \`${line}\`${indentDesc(line)}`).join(", ") +
    "?"
  );
}

interface IndexedEdit {
  index: number;
  edit: EditItem;
}

function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

function groupEditsByPath(edits: EditItem[], cwd: string): Map<string, IndexedEdit[]> {
  const groups = new Map<string, IndexedEdit[]>();
  for (let i = 0; i < edits.length; i++) {
    const abs = toAbsolute(edits[i].path, cwd);
    const bucket = groups.get(abs);
    if (bucket) {
      bucket.push({ index: i, edit: edits[i] });
    } else {
      groups.set(abs, [{ index: i, edit: edits[i] }]);
    }
  }
  return groups;
}

function sortGroupByPosition(group: IndexedEdit[], originalContent: string): void {
  if (group.length < 2) return;
  const positions = new Map<IndexedEdit, number>();
  for (const entry of group) {
    const match = findActualString(originalContent, entry.edit.oldText, 0);
    positions.set(entry, match === undefined ? Number.MAX_SAFE_INTEGER : match.pos);
  }
  group.sort((a, b) => positions.get(a)! - positions.get(b)!);
}

interface ApplyOptions {
  collectDiff?: boolean;
  rollbackOnError?: boolean;
  continueOnError?: boolean;
  /** If true, messages will say "Matched" instead of "Edited" so the agent does not think files were mutated. */
  isPreflight?: boolean;
}

export async function applyClassicEdits(
  edits: EditItem[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options: ApplyOptions = {},
): Promise<EditResult[]> {
  const { collectDiff = false, rollbackOnError = false, continueOnError = false } = options;

  const fileGroups = groupEditsByPath(edits, cwd);
  const results: EditResult[] = new Array(edits.length);

  await Promise.all(
    Array.from(fileGroups.keys(), (absPath) => workspace.checkWriteAccess(absPath)),
  );

  const snapshots = new Map<string, string>();

  try {
    for (const [absPath, group] of fileGroups) {
      throwIfAborted(signal);

      const originalContent = await workspace.readText(absPath);
      sortGroupByPosition(group, originalContent);

      let updatedContent: string;
      try {
        updatedContent = applyGroupToContent(group, originalContent, results, edits.length, signal, continueOnError, options.isPreflight ?? false);
      } catch (err) {
        if (continueOnError) continue;
        throw err;
      }

      if (updatedContent === originalContent) continue;

      snapshots.set(absPath, originalContent);
      await workspace.writeText(absPath, updatedContent);

      if (collectDiff) {
        const { diff, firstChangedLine } = generateDiffString(originalContent, updatedContent);
        const firstSuccessIdx = group.find((e) => results[e.index]?.success)?.index;
        if (firstSuccessIdx !== undefined) {
          results[firstSuccessIdx].diff = diff;
          results[firstSuccessIdx].firstChangedLine = firstChangedLine;
        }
      }
    }
  } catch (err) {
    if (rollbackOnError) {
      await rollbackSnapshots(snapshots, workspace);
    }
    throw err;
  }

  return results;
}

function applyGroupToContent(
  group: IndexedEdit[],
  originalContent: string,
  results: EditResult[],
  totalEdits: number,
  signal: AbortSignal | undefined,
  continueOnError = false,
  isPreflight = false,
): string {
  let content = originalContent;
  let searchOffset = 0;

  const appliedPairs = new Set<string>();
  const pairKey = (edit: EditItem) => `${edit.oldText}\0${edit.newText}`;
  let failedInFile = false;

  for (const { index, edit } of group) {
    throwIfAborted(signal);

    const match = findActualString(content, edit.oldText, searchOffset);

    if (match === undefined) {
      failedInFile = true;

      if (appliedPairs.has(pairKey(edit))) {
        results[index] = {
          path: edit.path,
          success: true,
          message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
        };
        continue;
      }

      const candidates = findTopCandidates(content, edit.oldText, 2);
      const suggestion = candidates.length > 0
        ? "Did you mean " + candidates.map(({ idx, line }) => `line ${idx}: \`${line}\``).join(", ") + "?"
        : undefined;
      const hint = diagnoseMismatch(edit.oldText, candidates);

      results[index] = {
        path: edit.path,
        success: false,
        message: `Could not find the exact text in ${edit.path}.` +
          (hint ? ` ${hint}` : "") +
          (suggestion ? ` ${suggestion}` : ""),
      };

      if (continueOnError) continue;

      markRemainingSkipped(group, index, results);
      throw new Error(formatResults(results.filter(Boolean), totalEdits, isPreflight));
    }

    const { pos, actualOldText } = match;

    if (failedInFile && continueOnError) {
      results[index] = {
        path: edit.path,
        success: true,
        skipped: true,
        preflight: isPreflight,
        message: `Matched ${edit.path}, but will be skipped in actual apply because an earlier edit failed.`,
      };
      searchOffset = pos + actualOldText.length;
      appliedPairs.add(pairKey(edit));
      continue;
    }

    content = content.slice(0, pos) + edit.newText + content.slice(pos + actualOldText.length);
    searchOffset = pos + edit.newText.length;
    appliedPairs.add(pairKey(edit));

    results[index] = {
      path: edit.path,
      success: true,
      preflight: isPreflight,
      message: isPreflight ? `Matched ${edit.path}.` : `Edited ${edit.path}.`,
    };
  }

  return content;
}

function markRemainingSkipped(group: IndexedEdit[], failedIndex: number, results: EditResult[]): void {
  const failedPos = group.findIndex((e) => e.index === failedIndex);
  for (let i = failedPos + 1; i < group.length; i++) {
    const pending = group[i];
    results[pending.index] = {
      path: pending.edit.path,
      success: false,
      message: `Skipped (earlier edit in ${pending.edit.path} failed).`,
    };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function rollbackSnapshots(snapshots: Map<string, string>, workspace: Workspace): Promise<void> {
  await Promise.all(
    Array.from(snapshots, ([absPath, original]) => workspace.writeText(absPath, original).catch(() => {})),
  );
}

export function formatResults(results: EditResult[], totalEdits: number, isPreflight = false): string {
  const lines: string[] = [];
  let hasSkipped = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.success ? (r.skipped ? "⊘" : (isPreflight ? "≈" : "✓")) : "✗";
    lines.push(`${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`);
    if (r.skipped) hasSkipped = true;
  }
  const remaining = totalEdits - results.length;
  if (remaining > 0) {
    lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
  }
  if (hasSkipped) {
    lines.push(
      `Note: ⊘ = matched but will be skipped in actual apply because an earlier edit failed. ` +
      `Fix the failed edit(s) and retry the whole batch.`,
    );
  }
  return lines.join("\n");
}
