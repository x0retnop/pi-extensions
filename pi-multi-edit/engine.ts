import { isAbsolute, resolve as resolvePath } from "path";

import { computeChangeStats, firstChangedLine } from "./diff.js";
import {
  buildMismatchHint,
  countOccurrences,
  findActualString,
  findAllMatches,
  findText,
  normalizeEditText,
  pairKey,
} from "./match.js";
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./normalize.js";
import type { EditItem, EditResult, Workspace } from "./types.js";

interface IndexedEdit {
  index: number;
  edit: EditItem;
}

interface ApplyOptions {
  preflight?: boolean;
  collectDiff?: boolean;
  continueOnError?: boolean;
}

function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

function groupByPath(edits: EditItem[], cwd: string): Map<string, IndexedEdit[]> {
  const groups = new Map<string, IndexedEdit[]>();
  for (let i = 0; i < edits.length; i++) {
    const abs = toAbsolute(edits[i].path, cwd);
    const bucket = groups.get(abs);
    if (bucket) bucket.push({ index: i, edit: edits[i] });
    else groups.set(abs, [{ index: i, edit: edits[i] }]);
  }
  return groups;
}

function applySingleEdit(
  content: string,
  match: { index: number; length: number },
  newText: string,
): string {
  return content.slice(0, match.index) + newText + content.slice(match.index + match.length);
}

function sortGroupByPosition(
  group: IndexedEdit[],
  content: string,
): IndexedEdit[] {
  if (group.length < 2) return group;
  const positions = new Map<IndexedEdit, number>();
  for (const entry of group) {
    const match = findText(content, normalizeEditText(entry.edit.oldText), 0);
    positions.set(entry, match?.index ?? Number.MAX_SAFE_INTEGER);
  }
  return [...group].sort((a, b) => positions.get(a)! - positions.get(b)!);
}

function matchEditsInFile(
  group: IndexedEdit[],
  rawContent: string,
  displayPath: string,
  totalEdits: number,
  options: ApplyOptions,
): { byIndex: Map<number, EditResult>; newRawContent?: string; changed: boolean } {
  const byIndex = new Map<number, EditResult>();
  const isPreflight = options.preflight ?? false;
  const continueOnError = options.continueOnError ?? false;

  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  let normalized = normalizeToLF(text);

  const appliedPairs = new Set<string>();
  let fileFailed = false;
  let searchOffset = 0;

  const sortedGroup = sortGroupByPosition(group, normalized);

  for (const { index, edit } of sortedGroup) {
    const ne = {
      oldText: normalizeEditText(edit.oldText),
      newText: normalizeEditText(edit.newText),
      replaceAll: edit.replaceAll ?? false,
    };

    if (!ne.oldText) {
      const msg = `oldText must not be empty in ${displayPath}.`;
      if (continueOnError) {
        byIndex.set(index, { path: displayPath, success: false, message: msg });
        continue;
      }
      throw new Error(msg);
    }

    if (appliedPairs.has(pairKey(edit))) {
      byIndex.set(index, {
        path: displayPath,
        success: true,
        skipped: true,
        message: `Skipped duplicate edit in ${displayPath}.`,
      });
      continue;
    }

    if (fileFailed && continueOnError) {
      byIndex.set(index, {
        path: displayPath,
        success: true,
        skipped: true,
        message: `Skipped (earlier edit in ${displayPath} failed).`,
      });
      continue;
    }

    if (ne.replaceAll) {
      const occurrences = findAllMatches(normalized, ne.oldText, searchOffset);
      if (occurrences.length === 0) {
        fileFailed = true;
        const hint = buildMismatchHint(normalized, ne.oldText, ne.newText);
        byIndex.set(index, {
          path: displayPath,
          success: false,
          message: `Could not find text in ${displayPath}. ${hint}`,
        });
        if (continueOnError) continue;
        throw new Error(formatResults([...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), totalEdits, isPreflight));
      }

      let localContent = normalized;
      for (let i = occurrences.length - 1; i >= 0; i--) {
        const occ = occurrences[i];
        localContent = applySingleEdit(localContent, occ, ne.newText);
      }
      normalized = localContent;
      appliedPairs.add(pairKey(edit));
      byIndex.set(index, {
        path: displayPath,
        success: true,
        message: isPreflight
          ? `Matched ${occurrences.length} occurrence(s) in ${displayPath}.`
          : `Replaced ${occurrences.length} occurrence(s) in ${displayPath}.`,
      });
      continue;
    }

    const match = findActualString(normalized, ne.oldText);
    if (!match) {
      fileFailed = true;
      const hint = buildMismatchHint(normalized, ne.oldText, ne.newText);
      byIndex.set(index, {
        path: displayPath,
        success: false,
        message: `Could not find text in ${displayPath}. ${hint}`,
      });
      if (continueOnError) continue;
      throw new Error(formatResults([...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), totalEdits, isPreflight));
    }

    const occurrences = countOccurrences(normalized, ne.oldText);
    if (occurrences > 1) {
      fileFailed = true;
      const msg =
        `Found ${occurrences} occurrences in ${displayPath}. ` +
        `oldText must be unique — add context or use replaceAll: true.`;
      byIndex.set(index, { path: displayPath, success: false, message: msg });
      if (continueOnError) continue;
      throw new Error(formatResults([...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), totalEdits, isPreflight));
    }

    normalized = applySingleEdit(normalized, match, ne.newText);
    // Continue searching from the replacement start so later edits can match
    // content introduced by earlier edits in the same batch.
    searchOffset = match.index;
    appliedPairs.add(pairKey(edit));
    byIndex.set(index, {
      path: displayPath,
      success: true,
      message: isPreflight ? `Matched ${displayPath}.` : `Edited ${displayPath}.`,
    });
  }

  if (fileFailed && continueOnError) {
    // Partial apply: keep successful edits, skip the rest, but still write
    // whatever changes accumulated before the first failure.
  }

  const restored = restoreLineEndings(normalized, lineEnding);
  const newRaw = bom + restored;
  return { byIndex, newRawContent: newRaw, changed: newRaw !== rawContent };
}

export function formatResults(
  results: EditResult[],
  totalEdits: number,
  isPreflight = false,
): string {
  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    const icon = r.success ? (r.skipped ? "⊘" : "✓") : "✗";
    const suffix = isPreflight && r.success && !r.skipped ? " (not applied)" : "";
    lines.push(`${icon} ${i + 1}/${totalEdits} ${r.path}: ${r.message}${suffix}`);
  }
  return lines.join("\n");
}

export async function applyEdits(
  edits: EditItem[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options: ApplyOptions = {},
): Promise<EditResult[]> {
  const groups = groupByPath(edits, cwd);
  const allResults: EditResult[] = new Array(edits.length);
  const snapshots = new Map<string, string>();

  await Promise.all([...groups.keys()].map((p) => workspace.checkWriteAccess(p)));

  try {
    for (const [absPath, group] of groups) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const displayPath = group[0].edit.path;
      const rawContent = await workspace.readText(absPath);

      const { byIndex, newRawContent, changed } = matchEditsInFile(
        group,
        rawContent,
        displayPath,
        edits.length,
        options,
      );

      for (const { index } of group) {
        allResults[index] = byIndex.get(index)!;
      }

      if (!changed || !newRawContent) continue;

      snapshots.set(absPath, rawContent);
      await workspace.writeText(absPath, newRawContent);

      if (options.collectDiff) {
        const stats = computeChangeStats(rawContent, newRawContent);
        const line = firstChangedLine(rawContent, newRawContent);
        for (const { index } of group) {
          const r = allResults[index];
          if (r?.success && !r.skipped && !r.stats) {
            allResults[index] = { ...r, stats, firstChangedLine: line };
          }
        }
      }
    }
  } catch (err) {
    if (!options.continueOnError && snapshots.size > 0) {
      await Promise.all(
        [...snapshots].map(([p, orig]) => workspace.writeText(p, orig).catch(() => {})),
      );
    }
    throw err;
  }

  return allResults;
}
