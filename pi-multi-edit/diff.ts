type ContextEntry = { kind: "context"; oldLine: number; newLine: number; text: string };
type AddedEntry = { kind: "added"; newLine: number; text: string };
type RemovedEntry = { kind: "removed"; oldLine: number; text: string };
type Entry = ContextEntry | AddedEntry | RemovedEntry;

interface ChangePart {
  added?: boolean;
  removed?: boolean;
  value: string;
}

function diffLines(oldArr: string[], newArr: string[]): ChangePart[] {
  const m = oldArr.length;
  const n = newArr.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) {
    return [{ added: true, value: newArr.map((l) => l + "\n").join("") }];
  }
  if (n === 0) {
    return [{ removed: true, value: oldArr.map((l) => l + "\n").join("") }];
  }

  const MAX_CELLS = 500_000;
  if (m * n > MAX_CELLS) {
    return [
      { removed: true, value: oldArr.map((l) => l + "\n").join("") },
      { added: true, value: newArr.map((l) => l + "\n").join("") },
    ];
  }

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
      i--;
      j--;
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
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

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
        oldNum++;
        newNum++;
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
      i++;
      continue;
    }
    if (entry.kind === "removed") {
      out.push(`-${pad(entry.oldLine)} ${entry.text}`);
      i++;
      continue;
    }

    const runStart = i;
    while (i < entries.length && entries[i].kind === "context") {
      i++;
    }
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

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const parts = diffLines(oldLines, newLines);
  const { entries, firstChangedLine } = expand(parts);

  const oldLineCount = oldContent.split("\n").length;
  const newLineCount = newContent.split("\n").length;
  const lineNumWidth = String(Math.max(oldLineCount, newLineCount)).length;

  const lines = render(entries, contextLines, lineNumWidth);

  return { diff: lines.join("\n"), firstChangedLine };
}
