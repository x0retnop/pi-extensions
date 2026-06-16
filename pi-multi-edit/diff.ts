import type { ChangeStats } from "./types.js";

/** Line-level change stats for TUI (+n / -n). No diff text is stored or returned. */

export function computeChangeStats(
  oldContent: string,
  newContent: string,
): ChangeStats {
  if (oldContent === newContent) return { added: 0, removed: 0 };

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Guard huge files — approximate via line-count delta.
  if (m * n > 500_000) {
    const delta = newLines.length - oldLines.length;
    if (delta >= 0) return { added: delta, removed: 0 };
    return { added: 0, removed: -delta };
  }

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = m;
  let j = n;
  let added = 0;
  let removed = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added++;
      j--;
    } else {
      removed++;
      i--;
    }
  }

  return { added, removed };
}

export function mergeStats(a: ChangeStats, b: ChangeStats): ChangeStats {
  return { added: a.added + b.added, removed: a.removed + b.removed };
}

export function firstChangedLine(oldContent: string, newContent: string): number | undefined {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const limit = Math.min(oldLines.length, newLines.length);
  for (let i = 0; i < limit; i++) {
    if (oldLines[i] !== newLines[i]) return i + 1;
  }
  if (newLines.length > oldLines.length) return limit + 1;
  return undefined;
}