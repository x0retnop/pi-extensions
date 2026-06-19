import { mergeStats } from "./diff.js";
import { formatResults } from "./engine.js";
import type { ChangeStats, EditItem, EditResult, ExecuteResult } from "./types.js";

function formatOkLine(r: EditResult, edit: EditItem): string {
  const line = r.firstChangedLine ? ` (line ${r.firstChangedLine})` : "";
  if (r.skipped) return `skip ${edit.path}: duplicate`;
  if (r.message.startsWith("Replaced")) return `ok ${edit.path}: ${r.message}`;
  return `ok ${edit.path}${line}`;
}

function aggregateStats(results: EditResult[]): ChangeStats {
  let stats = { added: 0, removed: 0 };
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.stats || seen.has(r.path)) continue;
    seen.add(r.path);
    stats = mergeStats(stats, r.stats);
  }
  return stats;
}

export function buildPreflightError(
  results: EditResult[],
  total: number,
  isBatch: boolean,
  partialApply?: boolean,
): string {
  const fails = results.filter((r) => !r.success).length;
  const matched = results.filter((r) => r.success && !r.skipped).length;
  if (partialApply) {
    return (
      "Partial apply completed — some edits did not match.\n" +
      `${matched}/${total} applied, ${fails}/${total} failed.\n` +
      formatResults(results, total, false)
    );
  }
  const intro = isBatch
    ? "Preflight failed — fix unmatched edit(s) and retry the whole call. No files modified.\n"
    : "Edit failed — fix oldText and retry. No files modified.\n";
  const matchedHint =
    isBatch && matched > 0
      ? `${matched}/${total} edits would match; only the failed one(s) need fixing.\n`
      : "";
  return (
    intro +
    `${fails}/${total} unmatched.\n` +
    matchedHint +
    formatResults(results, total, true)
  );
}

export function buildPartialErrorResponse(
  results: EditResult[],
  edits: EditItem[],
): ExecuteResult {
  const applied = results.filter((r) => r?.success && !r?.skipped);
  const failed = results.filter((r) => r && !r.success);
  const stats = aggregateStats(results);
  const firstChanged = results.find((r) => r?.firstChangedLine !== undefined)?.firstChangedLine;

  const header = `Partial apply: ${applied.length} applied, ${failed.length} failed.`;
  const lines = results.map((r, i) =>
    r.success ? formatOkLine(r, edits[i]) : `fail ${edits[i].path}: ${r.message}`,
  );

  return {
    content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
    details: { stats, firstChangedLine: firstChanged },
  };
}

export function buildSuccessResponse(
  results: EditResult[],
  edits: EditItem[],
): ExecuteResult {
  const applied = results.filter((r) => r?.success && !r?.skipped);
  const skipped = results.filter((r) => r?.success && r?.skipped);
  const stats = aggregateStats(results);
  const firstChanged = results.find((r) => r?.firstChangedLine !== undefined)?.firstChangedLine;

  let status: string;
  if (results.length === 1) {
    status = formatOkLine(results[0], edits[0]);
  } else {
    const header = `OK: ${applied.length} edit(s)${skipped.length ? `, ${skipped.length} skipped` : ""}`;
    const lines = results.map((r, i) => formatOkLine(r, edits[i]));
    status = `${header}\n${lines.join("\n")}`;
  }

  return {
    content: [{ type: "text", text: status }],
    details: { stats, firstChangedLine: firstChanged },
  };
}