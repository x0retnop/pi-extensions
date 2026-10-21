import {
  formatHistoryOutline,
  runtimeEntriesToOutlineEntries,
  type FormatOutlineOptions,
  type RuntimeSessionEntry,
} from "../common/history-outline.js";

export interface FormatHistoryInput {
  entries: RuntimeSessionEntry[];
  maxChars?: number;
}

export function formatHistoryForHandoff(input: FormatHistoryInput): string {
  const outlineEntries = runtimeEntriesToOutlineEntries(input.entries);
  return formatHistoryOutline(outlineEntries, {
    maxChars: input.maxChars ?? 65_000,
    includeTimestamps: true,
    includeLegend: true,
  });
}

export type { FormatOutlineOptions, RuntimeSessionEntry };
