import { normalizeEditString } from "./match.js";
import { normalizeForFuzzyMatch } from "./normalize.js";

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function truncate(text: string, max = 100): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Aggressive per-line key for HINT purposes only (never used for replacement). */
function lineKey(line: string): string {
  return normalizeForFuzzyMatch(line).trim().replace(/\s+/g, " ");
}

/**
 * Find the position in content where oldString is most likely intended to match.
 * Returns a line-based hint when a fuzzy match exists, or undefined.
 */
export function findClosestLineHint(content: string, oldString: string): number | undefined {
  const normalizedContent = normalizeEditString(content);
  const normalizedOld = normalizeEditString(oldString);

  // Prefer exact match if any.
  const exactIdx = normalizedContent.indexOf(normalizedOld);
  if (exactIdx !== -1) {
    return lineAt(normalizedContent, exactIdx);
  }

  // Fuzzy fallback.
  const fuzzyContent = content
    .normalize("NFKC")
    .split("\n")
    .map((l) => l.trimEnd().replace(/\s+/g, " "))
    .join("\n");
  const fuzzyOld = oldString
    .normalize("NFKC")
    .split("\n")
    .map((l) => l.trimEnd().replace(/\s+/g, " "))
    .join("\n");
  const fuzzyIdx = fuzzyContent.indexOf(fuzzyOld);
  if (fuzzyIdx !== -1) {
    return lineAt(fuzzyContent, fuzzyIdx);
  }

  return undefined;
}

/**
 * Show the actual file lines around a given line, numbered, so the agent can
 * rebuild old_string without a separate re-read.
 */
export function formatContextHint(content: string, line: number, radius = 2): string {
  const lines = content.split("\n");
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    out.push(`  ${String(n).padStart(width)} | ${truncate(lines[n - 1])}`);
  }
  return out.join("\n");
}

/**
 * For a multi-line old_string that does not match as a block, find WHICH line
 * diverges: the first line of old_string that exists nowhere in the file.
 * Also shows what the file actually has at that position (anchored on the
 * nearest preceding line that does exist) so the agent can fix old_string
 * immediately without re-reading the file.
 */
export function findMismatchHint(
  content: string,
  oldString: string,
): { hint: string; contextLine?: number } | undefined {
  const oldLines = oldString.split("\n");
  if (oldLines.length < 2) return undefined;

  const fileLines = content.split("\n");
  const keyToLine = new Map<string, number>();
  fileLines.forEach((text, i) => {
    const k = lineKey(text);
    if (k && !keyToLine.has(k)) keyToLine.set(k, i + 1);
  });

  let missing = -1;
  for (let i = 0; i < oldLines.length; i++) {
    const k = lineKey(oldLines[i]);
    if (!k) continue; // blank lines match anything
    if (!keyToLine.has(k)) {
      missing = i;
      break;
    }
  }

  if (missing === -1) {
    return {
      hint:
        "Every line of old_string exists in the file, but not as one contiguous block " +
        "(line order or extra lines in between). Re-read the target section.",
    };
  }

  let hint =
    `Line ${missing + 1} of old_string does not exist in the file: ` +
    `\`${truncate(oldLines[missing].trim())}\`.`;

  // Anchor on the nearest preceding line that exists and show the file's
  // actual text at the corresponding position.
  let contextLine: number | undefined;
  for (let j = missing - 1; j >= 0; j--) {
    const k = lineKey(oldLines[j]);
    if (!k) continue;
    const anchorLine = keyToLine.get(k);
    if (anchorLine !== undefined) {
      const fileLineNo = anchorLine + (missing - j);
      contextLine = fileLineNo;
      const actual = fileLines[fileLineNo - 1];
      if (actual !== undefined) {
        hint += ` The file has at line ${fileLineNo}: \`${truncate(actual.trim())}\`.`;
      }
      break;
    }
  }

  return { hint, contextLine };
}
