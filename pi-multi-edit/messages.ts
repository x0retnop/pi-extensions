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
): string {
  const fails = results.filter((r) => !r.success).length;
  const intro = isBatch
    ? "Preflight failed — fix unmatched edit(s) and retry the whole call. No files modified.\n"
    : "Edit failed — fix oldText and retry. No files modified.\n";
  return (
    intro +
    `${fails}/${total} unmatched.\n` +
    formatResults(results, total, true)
  );
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