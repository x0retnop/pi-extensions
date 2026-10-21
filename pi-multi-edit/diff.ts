export interface ChangeStats {
  added: number;
  removed: number;
}

/**
 * LCS cell budget. The DP is O(m×n) in time: 4000×4000 line regions cost ~90 ms, which is the
 * ceiling worth paying for a tool row. Above it the counts degrade to a net line delta — that
 * needs both changed regions (after trimming) to exceed 4000 lines.
 */
const LCS_CELL_LIMIT = 16_000_000;

/** LCS length of two line ranges — two DP rows, so memory stays O(min(m, n)). */
function lcsLength(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number,
): number {
  const m = aEnd - aStart;
  const n = bEnd - bStart;
  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const line = a[aStart + i - 1];
    for (let j = 1; j <= n; j++) {
      const up = prev[j];
      cur[j] = line === b[bStart + j - 1] ? prev[j - 1] + 1 : up >= cur[j - 1] ? up : cur[j - 1];
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/**
 * Lines added / removed between two file versions, LCS-based — a line whose text changed counts
 * as one removed *and* one added, so a rewrite of existing lines shows `-k` even when the file
 * grows. Counts follow from the LCS length alone (`removed = old - L`, `added = new - L`), which
 * is why no backtrack matrix is built: the earlier implementation allocated a full m×n one and
 * had to bail out above ~700×700 lines, silently reporting `+0 -0` for a one-line rewrite of a
 * 900-line file (now `+1 -1`).
 */
export function computeChangeStats(oldContent: string, newContent: string): ChangeStats {
  if (oldContent === newContent) return { added: 0, removed: 0 };

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Only the changed region reaches the DP: a 40-line edit in a 5000-line file runs on 40×55.
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const m = endOld - start;
  const n = endNew - start;
  if (m === 0) return { added: n, removed: 0 };
  if (n === 0) return { added: 0, removed: m };

  if (m * n > LCS_CELL_LIMIT) {
    const delta = n - m;
    return delta >= 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta };
  }

  const lcs = lcsLength(oldLines, start, endOld, newLines, start, endNew);
  return { added: n - lcs, removed: m - lcs };
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
