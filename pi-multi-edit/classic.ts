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
        updatedContent = applyGroupToContent(group, originalContent, results, edits.length, signal, continueOnError);
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
): string {
  let content = originalContent;
  let searchOffset = 0;

  const appliedPairs = new Set<string>();
  const pairKey = (edit: EditItem) => `${edit.oldText}\0${edit.newText}`;

  for (const { index, edit } of group) {
    throwIfAborted(signal);

    const match = findActualString(content, edit.oldText, searchOffset);

    if (match === undefined) {
      if (appliedPairs.has(pairKey(edit))) {
        results[index] = {
          path: edit.path,
          success: true,
          message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
        };
        continue;
      }

      results[index] = {
        path: edit.path,
        success: false,
        message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
      };

      if (continueOnError) continue;

      markRemainingSkipped(group, index, results);
      throw new Error(formatResults(results.filter(Boolean), totalEdits));
    }

    const { pos, actualOldText } = match;
    content = content.slice(0, pos) + edit.newText + content.slice(pos + actualOldText.length);
    searchOffset = pos + edit.newText.length;
    appliedPairs.add(pairKey(edit));

    results[index] = {
      path: edit.path,
      success: true,
      message: `Edited ${edit.path}.`,
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

export function formatResults(results: EditResult[], totalEdits: number): string {
  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.success ? "✓" : "✗";
    lines.push(`${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`);
  }
  const remaining = totalEdits - results.length;
  if (remaining > 0) {
    lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
  }
  return lines.join("\n");
}
