import { isAbsolute, resolve as resolvePath } from "path";

import { computeChangeStats, firstChangedLine } from "./diff.js";
import { withFileLock } from "./lock.js";
import {
  countOccurrences,
  findOccurrenceLines,
  findText,
  normalizeEditString,
} from "./match.js";
import { findClosestLineHint, findMismatchHint, formatContextHint } from "./hint.js";
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./normalize.js";
import type {
  ChangeStats,
  EditResult,
  InsertEdit,
  MultiEdit,
  SingleEdit,
  Workspace,
} from "./types.js";

function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

interface MatchFailure {
  kind: "not-found" | "duplicate" | "empty";
  message: string;
}

function buildErrorMessage(
  content: string,
  oldString: string,
  failure: MatchFailure,
): string {
  if (failure.kind === "empty") {
    return `EMPTY: ${failure.message}`;
  }

  if (failure.kind === "duplicate") {
    const lines = findOccurrenceLines(content, oldString, 5);
    const at = lines.length ? ` at lines ${lines.join(", ")}` : "";
    return (
      `AMBIGUOUS: ${failure.message.replace(/\.$/, "")}${at}. ` +
      "Add surrounding context to make old_string unique (copy a few lines around the occurrence you need), or set replace_all: true."
    );
  }

  // not-found: give the agent everything needed to retry without a re-read.
  let message = "NOT_FOUND: old_string does not match the file.";

  const mismatch = findMismatchHint(content, oldString);
  if (mismatch) {
    message += ` ${mismatch.hint}`;
  }

  const closestLine = mismatch?.contextLine ?? findClosestLineHint(content, oldString);
  if (closestLine !== undefined) {
    message += `\nActual file text around line ${closestLine}:\n${formatContextHint(content, closestLine)}`;
    message +=
      "\nFix old_string using the file text above and retry (re-read only if the block is larger than shown).";
  } else {
    message +=
      " No similar text found — re-read the section you intended to edit and rebuild old_string from it.";
  }

  return message;
}

function matchReplacement(
  content: string,
  oldString: string,
  replaceAll: boolean,
): {
  matches: Array<{ index: number; length: number; usedFuzzy: boolean }>;
  failure?: MatchFailure;
} {
  if (oldString.length === 0) {
    return {
      matches: [],
      failure: { kind: "empty", message: "old_string must not be empty." },
    };
  }

  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) {
    return {
      matches: [],
      failure: { kind: "not-found", message: `old_string not found in file.` },
    };
  }

  if (!replaceAll && occurrences > 1) {
    return {
      matches: [],
      failure: {
        kind: "duplicate",
        message: `Found ${occurrences} occurrence(s) of old_string.`,
      },
    };
  }

  const matches: Array<{ index: number; length: number; usedFuzzy: boolean }> = [];
  let pos = 0;
  while (true) {
    const m = findText(content, oldString, pos);
    if (!m) break;
    matches.push({ index: m.index, length: m.length, usedFuzzy: m.usedFuzzy });
    pos = m.index + Math.max(1, m.length);
    if (!replaceAll) break;
  }

  return { matches };
}

function applyReplacement(
  content: string,
  matches: Array<{ index: number; length: number; usedFuzzy: boolean }>,
  newString: string,
): string {
  let result = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    result = result.slice(0, m.index) + newString + result.slice(m.index + m.length);
  }
  return result;
}

interface ApplySingleResult {
  newContent: string;
  changed: boolean;
  result: EditResult;
}

function applySingleEdit(
  rawContent: string,
  displayPath: string,
  edit: { old_string: string; new_string: string; replace_all?: boolean },
  options: { preflight?: boolean },
): ApplySingleResult {
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const content = normalizeToLF(text);
  const oldString = normalizeEditString(edit.old_string);
  const newString = normalizeEditString(edit.new_string);

  const { matches, failure } = matchReplacement(content, oldString, edit.replace_all ?? false);

  if (failure) {
    return {
      newContent: rawContent,
      changed: false,
      result: {
        path: displayPath,
        success: false,
        message: buildErrorMessage(content, oldString, failure),
      },
    };
  }

  const usedFuzzy = matches.some((m) => m.usedFuzzy);
  const newNormalized = applyReplacement(content, matches, newString);
  const newRaw = bom + restoreLineEndings(newNormalized, lineEnding);
  const changed = newRaw !== rawContent;

  const stats = changed ? computeChangeStats(rawContent, newRaw) : undefined;
  const firstLine = changed ? firstChangedLine(rawContent, newRaw) : undefined;

  const verb = options.preflight ? "Matched" : "Replaced";
  const count = matches.length;
  const fuzzyNote = usedFuzzy ? " (fuzzy match — copy verbatim next time)" : "";

  return {
    newContent: newRaw,
    changed,
    result: {
      path: displayPath,
      success: true,
      message: changed
        ? `${verb} ${count} occurrence(s).${fuzzyNote}`
        : "⚠ No change — old_string and new_string are identical; the text may already be edited. Verify before continuing.",
      stats,
      firstChangedLine: firstLine,
      usedFuzzy,
    },
  };
}

interface BatchStepResult {
  index: number;
  edit: { old_string: string; new_string: string; replace_all?: boolean };
  success: boolean;
  message: string;
  usedFuzzy?: boolean;
}

function applyBatchEdits(
  rawContent: string,
  displayPath: string,
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>,
  options: { preflight?: boolean },
): { newRaw: string; results: BatchStepResult[] } {
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  let content = normalizeToLF(text);

  const results: BatchStepResult[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldString = normalizeEditString(edit.old_string);
    const newString = normalizeEditString(edit.new_string);

    if (oldString.length === 0) {
      results.push({
        index: i,
        edit,
        success: false,
        message: "EMPTY: old_string must not be empty.",
      });
      continue;
    }

    if (oldString === newString) {
      results.push({
        index: i,
        edit,
        success: true,
        message: "⚠ No change — old_string equals new_string (already applied?).",
      });
      continue;
    }

    const occurrences = countOccurrences(content, oldString);
    if (occurrences === 0) {
      results.push({
        index: i,
        edit,
        success: false,
        message: buildErrorMessage(content, oldString, {
          kind: "not-found",
          message: "old_string not found.",
        }),
      });
      continue;
    }
    if (!(edit.replace_all ?? false) && occurrences > 1) {
      results.push({
        index: i,
        edit,
        success: false,
        message: buildErrorMessage(content, oldString, {
          kind: "duplicate",
          message: `Found ${occurrences} occurrence(s) of old_string.`,
        }),
      });
      continue;
    }

    const matches: Array<{ index: number; length: number; usedFuzzy: boolean }> = [];
    let pos = 0;
    while (true) {
      const m = findText(content, oldString, pos);
      if (!m) break;
      matches.push({ index: m.index, length: m.length, usedFuzzy: m.usedFuzzy });
      pos = m.index + Math.max(1, m.length);
      if (!(edit.replace_all ?? false)) break;
    }

    const usedFuzzy = matches.some((m) => m.usedFuzzy);
    content = applyReplacement(content, matches, newString);
    const verb = options.preflight ? "Matched" : "Replaced";
    const fuzzyNote = usedFuzzy ? " (fuzzy match — copy verbatim next time)" : "";
    results.push({
      index: i,
      edit,
      success: true,
      message: `${verb} ${matches.length} occurrence(s).${fuzzyNote}`,
      usedFuzzy,
    });
  }

  const newRaw = bom + restoreLineEndings(content, lineEnding);
  return { newRaw, results };
}

function applyInsert(
  rawContent: string,
  displayPath: string,
  edit: InsertEdit,
  options: { preflight?: boolean },
): ApplySingleResult {
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const content = normalizeToLF(text);
  const newString = normalizeEditString(edit.new_string);

  const lines = content.split("\n");
  const insertLine = edit.insert_line;

  if (insertLine < 1 || insertLine > lines.length + 1) {
    return {
      newContent: rawContent,
      changed: false,
      result: {
        path: displayPath,
        success: false,
        message: `insert_line ${insertLine} is out of range. Valid range: 1..${lines.length + 1}.`,
      },
    };
  }

  if (newString.length === 0) {
    return {
      newContent: rawContent,
      changed: false,
      result: {
        path: displayPath,
        success: true,
        message: "No change (new_string is empty).",
      },
    };
  }

  lines.splice(insertLine - 1, 0, newString);
  const newNormalized = lines.join("\n");
  const newRaw = bom + restoreLineEndings(newNormalized, lineEnding);
  const changed = newRaw !== rawContent;

  const stats = changed ? computeChangeStats(rawContent, newRaw) : undefined;
  const firstLine = insertLine;
  const insertedLines = newString.split("\n").length;
  const verb = options.preflight ? "Would insert" : "Inserted";

  return {
    newContent: newRaw,
    changed,
    result: {
      path: displayPath,
      success: true,
      message: `${verb} ${insertedLines} line(s) at line ${insertLine}.`,
      stats,
      firstChangedLine: firstLine,
    },
  };
}

export interface ApplySingleOptions {
  preflight?: boolean;
}

export async function executeSingleEdit(
  edit: SingleEdit,
  workspace: Workspace,
  cwd: string,
  signal: AbortSignal | undefined,
  options: ApplySingleOptions = {},
): Promise<{ result: EditResult; changed: boolean }> {
  const absPath = toAbsolute(edit.path, cwd);
  return withFileLock(absPath, async () => {
    await workspace.checkWriteAccess(absPath);

    if (signal?.aborted) throw new Error("Operation aborted");

    const rawContent = await workspace.readText(absPath);
    const { newContent, changed, result } = applySingleEdit(rawContent, edit.path, edit, options);

    if (changed && !options.preflight) {
      await workspace.writeText(absPath, newContent);
    }

    return { result, changed };
  });
}

export interface ApplyMultiOptions {
  preflight?: boolean;
  continueOnError?: boolean;
}

export async function executeMultiEdit(
  multi: MultiEdit,
  workspace: Workspace,
  cwd: string,
  signal: AbortSignal | undefined,
  options: ApplyMultiOptions = {},
): Promise<{ results: EditResult[]; changed: boolean }> {
  const absPath = toAbsolute(multi.path, cwd);
  return withFileLock(absPath, async () => {
    await workspace.checkWriteAccess(absPath);

    if (signal?.aborted) throw new Error("Operation aborted");

    const rawContent = await workspace.readText(absPath);
    const { newRaw, results: stepResults } = applyBatchEdits(
      rawContent,
      multi.path,
      multi.edits,
      { preflight: options.preflight },
    );

    const allSuccess = stepResults.every((r) => r.success);
    const changed = newRaw !== rawContent;

    // Atomic by default: only write when every step succeeded or caller opted into partial apply.
    if (changed && !options.preflight && (allSuccess || options.continueOnError)) {
      await workspace.writeText(absPath, newRaw);
    }

    const stats = changed ? computeChangeStats(rawContent, newRaw) : undefined;
    const firstLine = changed ? firstChangedLine(rawContent, newRaw) : undefined;

    const editResults: EditResult[] = stepResults.map((r) => ({
      path: multi.path,
      success: r.success,
      message: r.message,
      usedFuzzy: r.usedFuzzy,
      ...(r.success && changed ? { stats, firstChangedLine: firstLine } : {}),
    }));

    return { results: editResults, changed };
  });
}

export interface ApplyInsertOptions {
  preflight?: boolean;
}

export async function executeInsert(
  edit: InsertEdit,
  workspace: Workspace,
  cwd: string,
  signal: AbortSignal | undefined,
  options: ApplyInsertOptions = {},
): Promise<{ result: EditResult; changed: boolean }> {
  const absPath = toAbsolute(edit.path, cwd);
  return withFileLock(absPath, async () => {
    await workspace.checkWriteAccess(absPath);

    if (signal?.aborted) throw new Error("Operation aborted");

    const rawContent = await workspace.readText(absPath);
    const { newContent, changed, result } = applyInsert(rawContent, edit.path, edit, options);

    if (changed && !options.preflight) {
      await workspace.writeText(absPath, newContent);
    }

    return { result, changed };
  });
}
