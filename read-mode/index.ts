import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildOverview,
  extractSection,
  grepInFile,
  headtail,
  truncateText,
  type OverviewResult,
} from "./parser.js";

// Safe truncation that handles ANSI escapes, surrogate pairs, and wide Unicode.
// Pi TUI requires no rendered line exceeds terminal width.
function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1000) return 1;
  if (cp >= 0x2E80 && cp <= 0xA4CF) return 2;
  if (cp >= 0xAC00 && cp <= 0xD7AF) return 2;
  if (cp >= 0x1100 && cp <= 0x11FF) return 2;
  if (cp >= 0xFF01 && cp <= 0xFF60) return 2;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2;
  if (cp >= 0x1F000) return 2;
  if (cp >= 0x2600 && cp <= 0x27BF) return 2;
  return 1;
}

function safeTruncate(str: string, maxWidth: number, suffix = "..."): string {
  str = str.replace(/\t/g, " ").replace(/\r/g, "");
  let visible = 0;
  let result = "";
  let inAnsi = false;

  for (let i = 0; i < str.length; ) {
    const chCode = str.charCodeAt(i);
    if (chCode === 0x1b && str.charCodeAt(i + 1) === 0x5b) {
      inAnsi = true;
      result += str[i];
      i++;
      continue;
    }
    if (inAnsi) {
      result += str[i];
      if ((chCode >= 0x41 && chCode <= 0x5a) || (chCode >= 0x61 && chCode <= 0x7a)) {
        inAnsi = false;
      }
      i++;
      continue;
    }
    let ch: string;
    let step: number;
    if (chCode >= 0xD800 && chCode <= 0xDBFF && i + 1 < str.length) {
      ch = str.slice(i, i + 2);
      step = 2;
    } else {
      ch = str[i];
      step = 1;
    }
    const w = charDisplayWidth(ch);
    if (visible + w > maxWidth - suffix.length) {
      result += suffix;
      break;
    }
    result += ch;
    visible += w;
    i += step;
  }
  return result;
}

const originalRead = createReadTool(process.cwd());

const cache = new Map<string, { mtimeMs: number; overview: OverviewResult }>();

async function getOverview(filePath: string): Promise<OverviewResult> {
  const s = await stat(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === s.mtimeMs) return cached.overview;
  const overview = await buildOverview(filePath);
  cache.set(filePath, { mtimeMs: s.mtimeMs, overview });
  return overview;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read file contents with mode-based navigation.\n\n" +
      "Modes:\n" +
      "- overview: Returns a structure map (functions, classes, headers) with line ranges. " +
      "  Use this FIRST for files larger than 200 lines instead of reading blindly.\n" +
      "- section: Reads a specific function, class, or header by name. " +
      "  Requires target. Fuzzy match: 'authenticate' matches 'async authenticate' and 'private authenticate'.\n" +
      "- grep: Searches inside a single file with context lines. " +
      "  Requires target. Use fixed_strings:true for literal text with regex metacharacters.\n" +
      "- headtail: Returns first 20 and last 20 lines. Use for large logs and config files.\n" +
      "- raw (default): Delegates to built-in reader. Supports images (PNG, JPG, etc.) — the model can SEE the image content. Also supports offset/limit.\n\n" +
      "Guidelines:\n" +
      "- Always start with mode:overview for unfamiliar files >200 lines.\n" +
      "- After overview, use mode:section with the exact name from the overview.\n" +
      "- Use mode:grep when you know a keyword exists but not which function it's in.\n" +
      "- Use the separate 'grep' tool (not mode:grep) for project-wide searches across multiple files.\n" +
      "- mode:headtail is for logs; for targeted log filtering use mode:grep instead.\n\n" +
      "Examples:\n" +
      '{ mode:"overview", path:"src/app.ts" }\n' +
      '{ mode:"section", path:"src/app.ts", target:"handleRequest" }\n' +
      '{ mode:"section", path:"src/app.ts", target:"handleRequest", limit:60 }\n' +
      '{ mode:"grep", path:"src/app.ts", target:"validateToken", contextLines:2 }\n' +
      '{ mode:"headtail", path:"logs/app.log" }\n' +
      '{ path:"screenshot.png" }  // image: omit mode (defaults to raw) so the model sees the picture',
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      mode: Type.Optional(
        StringEnum(["overview", "section", "grep", "headtail", "raw"], {
          description: "Reading mode. Default is raw (built-in behavior).",
        })
      ),
      target: Type.Optional(Type.String({ description: "Target name for section/grep modes" })),
      contextLines: Type.Optional(
        Type.Number({ default: 3, description: "Lines of context around each match for grep mode" })
      ),
      limit: Type.Optional(
        Type.Number({ default: 40, description: "Maximum lines to return. For section mode: lines from target. For raw mode: passed to built-in reader." })
      ),
      fixed_strings: Type.Optional(
        Type.Boolean({ default: false, description: "Treat target as literal string in grep mode" })
      ),
      maxBytes: Type.Optional(
        Type.Number({ default: 8192, description: "Maximum bytes to return" })
      ),
      offset: Type.Optional(Type.Number({ description: "Line offset for raw mode (delegated)" })),
    }),

    promptGuidelines: [
      "For large or unfamiliar files (>200 lines), start with mode:overview to see structure before reading blindly.",
      "Use mode:section with a target name to read a specific function, class, or header.",
      "Use mode:grep to search for a keyword inside a single file. Use the separate grep tool for project-wide search.",
      "Use mode:headtail for large log or config files when you only need the beginning and end.",
      "mode:raw is the default; use it for small files, images, or when you need the full content.",
      "When the user shares a screenshot, image, or asks to look at a picture, ALWAYS use read with mode:raw (or omit mode) so the model can see the image content.",
    ],

    renderCall(args: any, theme: any) {
      const mode = args.mode || "raw";
      let text = theme.fg("toolTitle", theme.bold(`read:${mode}`));
      text += " " + theme.fg("accent", args.path);
      if (args.target) {
        text += " " + theme.fg("dim", `target="${args.target}"`);
      }
      if (args.limit && args.limit !== 40) {
        text += " " + theme.fg("dim", `limit=${args.limit}`);
      }
      return {
        render(width: number) { return [safeTruncate(text, width, "...")]; },
        invalidate() {},
      };
    },

    async execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext
    ) {
      const filePath = resolve(ctx.cwd, params.path);
      const mode = params.mode || "raw";
      const maxBytes = params.maxBytes ?? 8192;

      if (mode === "raw") {
        return originalRead.execute(
          toolCallId,
          { path: params.path, offset: params.offset, limit: params.limit },
          signal,
          onUpdate
        );
      }

      try {
        if (mode === "overview") {
          const { sections, totalLines, sizeBytes } = await getOverview(filePath);

          if (sections.length === 0) {
            const text = `${params.path} (${totalLines} lines, ${Math.round(sizeBytes / 1024)}KB)\nNo recognizable structure found.`;
            const { text: out } = truncateText(text, maxBytes);
            return { content: [{ type: "text", text: out }], details: {} };
          }

          const lines = [`${params.path} (${totalLines} lines, ${Math.round(sizeBytes / 1024)}KB)`];
          for (const s of sections) {
            lines.push(`[line ${s.startLine}] ${s.name}`);
          }

          const result = lines.join("\n");
          const { text: out, truncated } = truncateText(result, maxBytes);
          return {
            content: [{ type: "text", text: out }],
            details: { truncated },
          };
        }

        if (mode === "section") {
          if (!params.target) {
            return {
              content: [{ type: "text", text: "Error: target is required for mode:section" }],
              details: { error: true },
            };
          }
          const result = await extractSection(filePath, params.target, params.limit ?? 40);
          if (result === null) {
            return {
              content: [{ type: "text", text: `Section "${params.target}" not found in ${params.path}` }],
              details: { error: true },
            };
          }
          if ("candidates" in result) {
            const lines = [`Multiple matches for "${params.target}":`];
            for (const c of result.candidates) {
              lines.push(`  [${c.line}] ${c.name}`);
            }
            lines.push("");
            lines.push("Use mode:section with a more specific target name.");
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { candidates: result.candidates },
            };
          }

          const header = `[lines ${result.startLine}-${result.endLine}]`;
          const body = result.lines.join("\n");
          const full = `${header}\n${body}`;
          const { text: out, truncated } = truncateText(full, maxBytes);
          return {
            content: [{ type: "text", text: out }],
            details: { startLine: result.startLine, endLine: result.endLine, truncated },
          };
        }

        if (mode === "grep") {
          if (!params.target) {
            return {
              content: [{ type: "text", text: "Error: target is required for mode:grep" }],
              details: { error: true },
            };
          }
          const result = await grepInFile(
            filePath,
            params.target,
            params.contextLines ?? 3,
            params.fixed_strings ?? false
          );
          const { text: out, truncated } = truncateText(result, maxBytes);
          return {
            content: [{ type: "text", text: out }],
            details: { truncated },
          };
        }

        if (mode === "headtail") {
          const result = await headtail(filePath, 20, 20);
          const { text: out, truncated } = truncateText(result, maxBytes);
          return {
            content: [{ type: "text", text: out }],
            details: { truncated },
          };
        }

        return {
          content: [{ type: "text", text: `Unknown mode: ${mode}` }],
          details: { error: true },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          details: { error: true },
        };
      }
    },
  });
}
