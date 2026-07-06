import type { ChangeStats, EditResult } from "./types.js";

export function buildSingleSuccess(
  result: EditResult,
  stats?: ChangeStats,
  firstChangedLine?: number,
): { content: { type: "text"; text: string }[]; details: { stats?: ChangeStats; firstChangedLine?: number } } {
  const line = firstChangedLine ? ` (line ${firstChangedLine})` : "";
  const fuzzy = result.usedFuzzy ? " [fuzzy]" : "";
  return {
    content: [{ type: "text", text: `Edited ${result.path}${line}.${fuzzy}` }],
    details: { stats, firstChangedLine },
  };
}

export function buildSingleError(path: string, message: string): never {
  throw new Error(`Could not edit ${path}: ${message}`);
}

export function buildMultiSuccess(
  path: string,
  results: EditResult[],
  stats?: ChangeStats,
  firstChangedLine?: number,
): { content: { type: "text"; text: string }[]; details: { stats?: ChangeStats; firstChangedLine?: number } } {
  const applied = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const lines = results.map((r, i) => {
    const icon = r.success ? "✓" : "✗";
    const fuzzy = r.usedFuzzy ? " [fuzzy]" : "";
    return `${icon} edits[${i}]: ${r.message}${fuzzy}`;
  });

  const header = failed > 0
    ? `Partial apply: ${applied}/${results.length} edits applied, ${failed} failed.`
    : `Batch edit applied: ${applied}/${results.length} edits.`;

  return {
    content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
    details: { stats, firstChangedLine },
  };
}

export function buildMultiError(path: string, results: EditResult[]): never {
  const errors = results
    .filter((r) => !r.success)
    .map((r, i) => `  edits[${i}]: ${r.message}`)
    .join("\n");
  const successes = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.success)
    .map(({ i }) => `edits[${i}]`)
    .join(", ");
  const hint = successes
    ? `\nHint: ${successes} matched successfully but were not applied because the batch failed. Fix the failing edits and retry, or split into smaller single-edit calls.`
    : "";
  throw new Error(`Batch edit failed for ${path}. No files modified.\n${errors}${hint}`);
}

export function buildInsertSuccess(
  result: EditResult,
  stats?: ChangeStats,
  firstChangedLine?: number,
): { content: { type: "text"; text: string }[]; details: { stats?: ChangeStats; firstChangedLine?: number } } {
  const line = firstChangedLine ? ` at line ${firstChangedLine}` : "";
  return {
    content: [{ type: "text", text: `Inserted into ${result.path}${line}.` }],
    details: { stats, firstChangedLine },
  };
}

export function buildInsertError(path: string, message: string): never {
  throw new Error(`Could not insert into ${path}: ${message}`);
}
