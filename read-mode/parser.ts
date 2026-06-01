import { readFile } from "node:fs/promises";

export interface Section {
  name: string;
  type: string;
  startLine: number; // 1-indexed
}

export interface OverviewResult {
  sections: Section[];
  totalLines: number;
  sizeBytes: number;
}

function detectLanguage(filePath: string): "js" | "ts" | "python" | "markdown" | "json" | "other" {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".md") || filePath.endsWith(".mdx")) return "markdown";
  if (filePath.endsWith(".json") || filePath.endsWith(".jsonc")) return "json";
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "ts";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "js";
  return "other";
}

function getTopLevelRegex(lang: string): RegExp | null {
  switch (lang) {
    case "ts":
    case "js":
      return /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum)\s+(\w+)/;
    case "python":
      return /^(class|def)\s+(\w+)/;
    case "markdown":
      return /^(#{1,6})\s+(.+)/;
    case "json":
      return /^\s*"([^"]+)"\s*:/;
    default:
      return null;
  }
}

export async function buildOverview(filePath: string): Promise<OverviewResult> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const lang = detectLanguage(filePath);
  const regex = getTopLevelRegex(lang);
  const sections: Section[] = [];

  if (regex) {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(regex);
      if (match) {
        let name = "";
        let type = "block";
        if (lang === "markdown") {
          name = match[2].trim();
          type = `h${match[1].length}`;
        } else if (lang === "json") {
          name = match[1];
          type = "key";
        } else if (match[4]) {
          name = match[4];
          type = match[3] || "declaration";
        } else if (match[2]) {
          name = match[2];
          type = match[1];
        }
        if (name) {
          sections.push({ name, type, startLine: i + 1 });
        }
      }
    }
  }

  return { sections, totalLines: lines.length, sizeBytes: Buffer.byteLength(content, "utf-8") };
}

function getSectionStartRegex(target: string, lang: string): RegExp {
  const t = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (lang) {
    case "ts":
    case "js":
      return new RegExp(
        `^\\s*(export\\s+)?(async\\s+)?(function|class|interface|type|enum|const|let|var)\\s+${t}\\b`,
        "i"
      );
    case "python":
      return new RegExp(`^(class|def)\\s+${t}\\b`, "i");
    case "markdown":
      return new RegExp(`^#{1,6}\\s+.*\\b${t}\\b`, "i");
    default:
      return new RegExp(`\\b${t}\\b`, "i");
  }
}

export async function extractSection(
  filePath: string,
  target: string,
  limit: number
): Promise<{ lines: string[]; startLine: number; endLine: number } | { candidates: { name: string; line: number }[] } | null> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const lang = detectLanguage(filePath);
  const regex = getSectionStartRegex(target, lang);

  const matches: { name: string; line: number; idx: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const nameMatch = lines[i].match(
        /(?:function|class|interface|type|enum|const|let|var|def)\s+(\w+)|^#{1,6}\s+(.+)|^\s*(\w+)\s*\(/
      );
      const name = nameMatch ? nameMatch[1] || nameMatch[2] || nameMatch[3] : `line ${i + 1}`;
      matches.push({ name: name || `line ${i + 1}`, line: i + 1, idx: i });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { candidates: matches.map((m) => ({ name: m.name, line: m.line })) };
  }

  const startIdx = matches[0].idx;
  const startLine = matches[0].line;
  const endIdx = Math.min(lines.length - 1, startIdx + limit - 1);

  return {
    lines: lines.slice(startIdx, endIdx + 1),
    startLine,
    endLine: endIdx + 1,
  };
}

export async function grepInFile(
  filePath: string,
  pattern: string,
  contextLines: number,
  fixedStrings: boolean
): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const ranges: { start: number; end: number }[] = [];

  let regex: RegExp;
  if (fixedStrings) {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "");
  } else {
    try {
      regex = new RegExp(pattern, "");
    } catch (e) {
      throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      ranges.push({
        start: Math.max(0, i - contextLines),
        end: Math.min(lines.length - 1, i + contextLines),
      });
    }
  }

  if (ranges.length === 0) return "(no matches)";

  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    if (merged.length === 0 || r.start > merged[merged.length - 1].end + 1) {
      merged.push({ ...r });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    }
  }

  const out: string[] = [];
  for (const r of merged) {
    out.push(`[lines ${r.start + 1}-${r.end + 1}]`);
    for (let i = r.start; i <= r.end; i++) {
      const isMatch = regex.test(lines[i]);
      const marker = isMatch ? ">" : " ";
      out.push(`${marker} ${i + 1}: ${lines[i]}`);
    }
    out.push("");
  }

  return out.join("\n").trim();
}

export async function headtail(filePath: string, headSize: number, tailSize: number): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  if (lines.length <= headSize + tailSize) {
    return content;
  }
  const head = lines.slice(0, headSize).join("\n");
  const tail = lines.slice(-tailSize).join("\n");
  const skipped = lines.length - headSize - tailSize;
  return `[Head: lines 1-${headSize}]\n${head}\n\n[... skipped ${skipped} lines ...]\n\n[Tail: lines ${lines.length - tailSize + 1}-${lines.length}]\n${tail}`;
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0b11000000) === 0b10000000) {
    cut--;
  }
  return {
    text: buf.slice(0, cut).toString("utf-8") + "\n\n[Truncated: use mode:section or mode:grep to narrow down]",
    truncated: true,
  };
}
