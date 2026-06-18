import { isAbsolute, resolve as resolvePath } from "path";

import { computeChangeStats, firstChangedLine } from "./diff.js";
import {
  buildMismatchHint,
  countOccurrences,
  findAllMatches,
  findText,
  normalizeEditText,
} from "./match.js";
import {
  detectLineEnding,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./normalize.js";
import type { EditItem, EditResult, Workspace } from "./types.js";

interface IndexedEdit {
  index: number;
  edit: EditItem;
}

interface MatchedEdit {
  matchIndex: number;
  matchLength: number;
  newText: string;
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

function pairKey(edit: EditItem): string {
  return `${edit.oldText}\0${edit.newText}`;
}

function applyMatchedToContent(
  baseContent: string,
  matched: MatchedEdit[],
): string {
  const sorted = [...matched].sort((a, b) => b.matchIndex - a.matchIndex);
  let content = baseContent;
  for (const m of sorted) {
    content =
      content.slice(0, m.matchIndex) +
      m.newText +
      content.slice(m.matchIndex + m.matchLength);
  }
  return content;
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
  const normalized = normalizeToLF(text);

  const normalizedEdits = group.map(({ edit }) => ({
    oldText: normalizeEditText(edit.oldText),
    newText: normalizeEditText(edit.newText),
    replaceAll: edit.replaceAll ?? false,
  }));

  for (let gi = 0; gi < normalizedEdits.length; gi++) {
    if (!normalizedEdits[gi].oldText) {
      const msg = `oldText must not be empty in ${displayPath}.`;
      if (continueOnError) {
        byIndex.set(group[gi].index, { path: displayPath, success: false, message: msg });
        continue;
      }
      throw new Error(msg);
    }
  }

  const initialMatches = normalizedEdits.map((e) => findText(normalized, e.oldText));
  const useFuzzySpace = initialMatches.some((m) => m?.usedFuzzy);
  const baseContent = useFuzzySpace ? normalizeForFuzzyMatch(normalized) : normalized;

  const appliedPairs = new Set<string>();
  const matched: MatchedEdit[] = [];
  let fileFailed = false;

  for (let gi = 0; gi < group.length; gi++) {
    const { index, edit } = group[gi];
    const ne = normalizedEdits[gi];

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
      const occurrences = findAllMatches(baseContent, ne.oldText);
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

      for (const occ of occurrences) {
        matched.push({
          matchIndex: occ.index,
          matchLength: occ.length,
          newText: ne.newText,
        });
      }
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

    const match = findText(baseContent, ne.oldText);
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

    const occurrences = countOccurrences(baseContent, ne.oldText);
    if (occurrences > 1) {
      fileFailed = true;
      const msg =
        `Found ${occurrences} occurrences in ${displayPath}. ` +
        `oldText must be unique — add context or use replaceAll: true.`;
      byIndex.set(index, { path: displayPath, success: false, message: msg });
      if (continueOnError) continue;
      throw new Error(formatResults([...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), totalEdits, isPreflight));
    }

    matched.push({
      matchIndex: match.index,
      matchLength: match.length,
      newText: ne.newText,
    });
    appliedPairs.add(pairKey(edit));
    byIndex.set(index, {
      path: displayPath,
      success: true,
      message: isPreflight
        ? `Matched ${displayPath}.`
        : `Edited ${displayPath}.`,
    });
  }

  if (fileFailed && continueOnError) {
    return { byIndex, changed: false };
  }

  const sorted = [...matched].sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.matchIndex + prev.matchLength > cur.matchIndex) {
      const msg = `Edits overlap in ${displayPath} — merge them into one edit.`;
      if (continueOnError) {
        for (const { index } of group) {
          const r = byIndex.get(index);
          if (!r || r.success) {
            byIndex.set(index, { path: displayPath, success: false, message: msg });
          }
        }
        return { byIndex, changed: false };
      }
      throw new Error(msg);
    }
  }

  const newNormalized = applyMatchedToContent(baseContent, matched);
  if (newNormalized === baseContent) {
    const msg = `No changes in ${displayPath}.`;
    if (continueOnError) {
      for (const { index } of group) {
        const r = byIndex.get(index);
        if (r?.success && !r.skipped) {
          byIndex.set(index, { path: displayPath, success: false, message: msg });
        }
      }
      return { byIndex, changed: false };
    }
    throw new Error(msg);
  }

  const restored = restoreLineEndings(newNormalized, lineEnding);
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

