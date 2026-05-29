import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type ContextEntry = { kind: "context"; oldLine: number; newLine: number; text: string };
type AddedEntry = { kind: "added"; newLine: number; text: string };
type RemovedEntry = { kind: "removed"; oldLine: number; text: string };
type Entry = ContextEntry | AddedEntry | RemovedEntry;

interface ChangePart {
  added?: boolean;
  removed?: boolean;
  value: string;
}

const MAX_DIFF_OUTPUT_LINES = 200;
const MAX_LCS_CELLS = 500_000;

function unifiedDiff(oldContent: string, newContent: string): string | undefined {
  const tmpDir = mkdtempSync(join(tmpdir(), "pime-"));
  const oldFile = join(tmpDir, "a");
  const newFile = join(tmpDir, "b");
  try {
    writeFileSync(oldFile, oldContent, "utf8");
    writeFileSync(newFile, newContent, "utf8");
    const out = execSync(`diff -u "${oldFile}" "${newFile}"`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return out;
  } catch (err: any) {
    if (err.status === 1 && typeof err.stdout === "string") {
      return err.stdout;
    }
    return undefined;
  } finally {
    try { unlinkSync(oldFile); } catch {}
    try { unlinkSync(newFile); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }
}

function findFirstChangedLineInUnified(diff: string): number | undefined {
  for (const line of diff.split("\n")) {
    const m = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function clampDiffLines(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join("\n") + "\n... (diff truncated)";
}

function diffLines(oldArr: string[], newArr: string[]): ChangePart[] {
  const m = oldArr.length;
  const n = newArr.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ added: true, value: newArr.map((l) => l + "\n").join("") }];
  if (n === 0) return [{ removed: true, value: oldArr.map((l) => l + "\n").join("") }];
  if (m * n > MAX_LCS_CELLS) return [];

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldArr[i - 1] === newArr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const parts: ChangePart[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldArr[i - 1] === newArr[j - 1]) {
      parts.unshift({ value: oldArr[i - 1] + "\n" });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      parts.unshift({ added: true, value: newArr[j - 1] + "\n" });
      j--;
    } else {
      parts.unshift({ removed: true, value: oldArr[i - 1] + "\n" });
      i--;
    }
  }

  const merged: ChangePart[] = [];
  for (const part of parts) {
    if (merged.length === 0) {
      merged.push(part);
      continue;
    }
    const last = merged[merged.length - 1];
    if (last.added === part.added && last.removed === part.removed) {
      last.value += part.value;
    } else {
      merged.push(part);
    }
  }

  return merged;
}

function expand(parts: ChangePart[]): { entries: Entry[]; firstChangedLine: number | undefined } {
  const entries: Entry[] = [];
  let oldNum = 1;
  let newNum = 1;
  let firstChangedLine: number | undefined;

  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    for (const text of lines) {
      if (part.added) {
        if (firstChangedLine === undefined) firstChangedLine = newNum;
        entries.push({ kind: "added", newLine: newNum, text });
        newNum++;
      } else if (part.removed) {
        if (firstChangedLine === undefined) firstChangedLine = newNum;
        entries.push({ kind: "removed", oldLine: oldNum, text });
        oldNum++;
      } else {
        entries.push({ kind: "context", oldLine: oldNum, newLine: newNum, text });
        oldNum++; newNum++;
      }
    }
  }

  return { entries, firstChangedLine };
}

function render(entries: Entry[], contextLines: number, lineNumWidth: number): string[] {
  const pad = (n: number) => String(n).padStart(lineNumWidth, " ");
  const blankGutter = " ".repeat(lineNumWidth);
  const out: string[] = [];

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind === "added") {
      out.push(`+${pad(entry.newLine)} ${entry.text}`);
      i++; continue;
    }
    if (entry.kind === "removed") {
      out.push(`-${pad(entry.oldLine)} ${entry.text}`);
      i++; continue;
    }

    const runStart = i;
    while (i < entries.length && entries[i].kind === "context") i++;
    const runEnd = i;
    const runLen = runEnd - runStart;
    const hasChangeBefore = runStart > 0;
    const hasChangeAfter = runEnd < entries.length;

    if (!hasChangeBefore && !hasChangeAfter) continue;

    const head = hasChangeBefore ? contextLines : 0;
    const tail = hasChangeAfter ? contextLines : 0;
    const writeAt = (idx: number) => {
      const e = entries[idx] as ContextEntry;
      out.push(` ${pad(e.oldLine)} ${e.text}`);
    };

    if (runLen <= head + tail) {
      for (let j = runStart; j < runEnd; j++) writeAt(j);
      continue;
    }

    for (let j = 0; j < head; j++) writeAt(runStart + j);
    out.push(` ${blankGutter} ...`);
    for (let j = tail; j > 0; j--) writeAt(runEnd - j);
  }

  return out;
}

function buildCompactDiff(oldContent: string, newContent: string, contextLines: number): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const parts = diffLines(oldLines, newLines);
  const { entries, firstChangedLine } = expand(parts);
  const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
  const lines = render(entries, contextLines, lineNumWidth);
  return lines.join("\n");
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const m = oldContent.split("\n").length;
  const n = newContent.split("\n").length;

  const unified = unifiedDiff(oldContent, newContent);
  if (unified) {
    const lineCount = unified.split("\n").length;
    if (lineCount <= MAX_DIFF_OUTPUT_LINES) {
      return { diff: unified, firstChangedLine: findFirstChangedLineInUnified(unified) };
    }
    // diff -u gave too many lines — too many changes, show summary
    return { diff: `--- old (${m} lines)\n+++ new (${n} lines)`, firstChangedLine: undefined };
  }

  // Fallback to compact LCS diff for small files only
  if (m * n <= MAX_LCS_CELLS) {
    const diff = buildCompactDiff(oldContent, newContent, contextLines);
    if (diff.split("\n").length <= MAX_DIFF_OUTPUT_LINES) {
      // firstChangedLine is approximate for compact diff (first changed new line)
      const firstChangedLine = diff.match(/\+(\d+)/)?.[1];
      return { diff, firstChangedLine: firstChangedLine ? parseInt(firstChangedLine, 10) : undefined };
    }
  }

  return { diff: `--- old (${m} lines)\n+++ new (${n} lines)`, firstChangedLine: undefined };
}
