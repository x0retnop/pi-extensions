import type { ExtensionAPI, ExtensionToolContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildOverview,
  extractSection,
  truncateText,
  type OverviewResult,
} from "./parser.js";

const originalRead = createReadToolDefinition(process.cwd());

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
      "Read a file. overview: structure map; logs, configs and plain text return no structure — use raw. " +
      "section: one block by target, fuzzy name; a short limit truncates and reports the block length. " +
      "raw (default): offset/limit, and images.",
    parameters: Type.Object({
      path: Type.String({ description: "File path." }),
      mode: Type.Optional(
        StringEnum(["overview", "section", "raw"], {
          description: "overview | section | raw. Default raw.",
        })
      ),
      target: Type.Optional(Type.String({ description: "Block name for section." })),
      limit: Type.Optional(
        Type.Number({ description: "Max lines. Section returns the whole block if it fits. Raw: lines from offset." })
      ),
      offset: Type.Optional(Type.Number({ description: "Raw start line, 1-indexed." })),
    }),

    renderCall(args: any, theme: any, context: any) {
      // Mirror execute: raw + target runs section, so the row never names a mode that did not run.
      let mode = args.mode || "raw";
      if (mode === "raw" && args.target) mode = "section";

      let text = theme.fg("toolTitle", theme.bold(`read:${mode}`));
      text += " " + (typeof args.path === "string" && args.path
        ? theme.fg("accent", args.path)
        : theme.fg("muted", "..."));
      if (args.target) {
        text += " " + theme.fg("dim", `target="${args.target}"`);
      }
      if (args.offset !== undefined || args.limit !== undefined) {
        text += " " + theme.fg("dim", `offset=${args.offset ?? 1}`);
        if (args.limit !== undefined) {
          text += " " + theme.fg("dim", `limit=${args.limit}`);
        }
      }

      // pi-tui `Text` wraps to the terminal width on its own: a long path or a long target name is
      // never cut off. The old hand-built line truncated at `width` and dropped `target`/`offset`/
      // `limit` first — the row lost the only facts it carries, and nothing could bring them back.
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(text);
      return component;
    },

    async execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionToolContext
    ) {
      const filePath = resolve(ctx.cwd, params.path);
      const maxBytes = 65536;

      // Auto-correct: raw + target -> section (agent-friendly safety net)
      let effectiveMode = params.mode || "raw";
      if (effectiveMode === "raw" && params.target) {
        effectiveMode = "section";
      }

      if (effectiveMode === "raw") {
        const ext = filePath.split(".").pop()?.toLowerCase();
        const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
        if (imageExts.has(ext || "")) {
          const rawParams: any = { path: params.path, offset: params.offset };
          if (params.limit != null) {
            rawParams.limit = params.limit;
          }
          // Definition form + ctx: the built-in resolves the path against `ctx.cwd` and needs
          // `ctx.model` for image resize limits and the non-vision note.
          return originalRead.execute(toolCallId, rawParams, signal, onUpdate, ctx);
        }

        const content = await readFile(filePath, "utf-8");
        const allLines = content.split("\n");
        const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
        const startLineDisplay = startLine + 1;

        if (startLine >= allLines.length) {
          return {
            content: [{ type: "text", text: `Error: offset ${params.offset} is beyond end of file (${allLines.length} lines total)` }],
            details: { error: true },
            isError: true,
          };
        }

        const firstLineBuf = Buffer.from(allLines[startLine], "utf-8");
        if (firstLineBuf.length > maxBytes) {
          return {
            content: [{ type: "text", text: `[Line ${startLineDisplay} exceeds ${Math.round(maxBytes / 1024)}KB limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${maxBytes}]` }],
            details: { error: true },
            isError: true,
          };
        }

        let selectedContent: string;
        let userLimitedLines: number | undefined;
        if (params.limit !== undefined) {
          const endLine = Math.min(startLine + params.limit, allLines.length);
          selectedContent = allLines.slice(startLine, endLine).join("\n");
          userLimitedLines = endLine - startLine;
        } else {
          selectedContent = allLines.slice(startLine).join("\n");
        }

        const buf = Buffer.from(selectedContent, "utf-8");
        if (buf.length <= maxBytes) {
          let text = selectedContent;
          if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
            const nextOffset = startLine + userLimitedLines + 1;
            text += `\n\n[${allLines.length - (startLine + userLimitedLines)} more lines in file. Use offset=${nextOffset} to continue.]`;
          }
          return { content: [{ type: "text", text }], details: {} };
        }

        let cut = maxBytes;
        while (cut > 0 && (buf[cut] & 0b11000000) === 0b10000000) cut--;
        const truncated = buf.slice(0, cut).toString("utf-8");
        const shownLines = truncated.split("\n").length;
        const endLineDisplay = startLineDisplay + shownLines - 1;
        const nextOffset = endLineDisplay + 1;
        const text = truncated + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${Math.round(maxBytes / 1024)}KB limit). Use offset=${nextOffset} to continue.]`;
        return { content: [{ type: "text", text }], details: { truncated: true } };
      }

      try {
        if (effectiveMode === "overview") {
          const { sections, totalLines, sizeBytes } = await getOverview(filePath);

          if (sections.length === 0) {
            const text = `${params.path} (${totalLines} lines, ${Math.round(sizeBytes / 1024)}KB)\nNo recognizable structure found.`;
            const { text: out } = truncateText(text, maxBytes);
            return { content: [{ type: "text", text: out }], details: {} };
          }

          const lines = [`${params.path} (${totalLines} lines, ${Math.round(sizeBytes / 1024)}KB)`];
          for (const s of sections) {
            // type first so agents can skim kind; qualified C++ names stay in s.name
            lines.push(`[line ${s.startLine}] ${s.type} ${s.name}`);
          }

          const result = lines.join("\n");
          const { text: out, truncated } = truncateText(result, maxBytes);
          return {
            content: [{ type: "text", text: out }],
            details: { truncated },
          };
        }

        if (effectiveMode === "section") {
          if (!params.target) {
            return {
              content: [{ type: "text", text: "Error: target is required for mode:section" }],
              details: { error: true },
              isError: true,
            };
          }
          const result = await extractSection(filePath, params.target, params.limit ?? 120);
          if (result === null) {
            return {
              content: [{ type: "text", text: `Section "${params.target}" not found in ${params.path}` }],
              details: { error: true },
              isError: true,
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

          let header = `[lines ${result.startLine}-${result.endLine}]`;
          if (result.blockEndDetected && result.totalBlockLines !== undefined) {
            header += ` (block: ${result.totalBlockLines} lines)`;
          }
          const body = result.lines.join("\n");
          let full = `${header}\n${body}`;

          if (result.blockTruncated) {
            const suggestedLimit = Math.max((params.limit ?? 120) * 2, result.totalBlockLines ?? 0, 250);
            full += `\n\n[Block truncated at limit. Total block length: ${result.totalBlockLines} lines. Use limit=${suggestedLimit} (or mode:raw with offset=${result.endLine + 1}) to continue.]`;
          } else if (!result.blockEndDetected && result.lines.length >= (params.limit ?? 120)) {
            full += `\n\n[End of block not detected. The content may continue beyond the limit. Use a larger limit or mode:raw with offset=${result.endLine + 1} if needed.]`;
          }

          const { text: out, truncated } = truncateText(full, maxBytes);
          return {
            content: [{ type: "text", text: out }],
            details: {
              startLine: result.startLine,
              endLine: result.endLine,
              truncated,
              blockEndDetected: result.blockEndDetected,
              blockTruncated: result.blockTruncated,
              totalBlockLines: result.totalBlockLines,
            },
          };
        }

        return {
          content: [{ type: "text", text: `Unknown mode: ${effectiveMode}` }],
          details: { error: true },
          isError: true,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  });
}
