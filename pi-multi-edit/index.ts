import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { applyClassicEdits, formatResults } from "./classic.js";
import { applyPatchOperations, parsePatch } from "./patch.js";
import type { EditItem } from "./types.ts";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.js";

const singleEditItemSchema = Type.Object(
  {
    oldText: Type.String({
      description: "Exact text to find and replace (must match exactly)",
    }),
    newText: Type.String({
      description: "New text to replace the old text with",
    }),
  },
  { additionalProperties: false },
);

const multiEditItemSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file to edit (relative or absolute). REQUIRED for every item in multi.",
    }),
    oldText: Type.String({
      description: "Exact text to find and replace (must match exactly)",
    }),
    newText: Type.String({
      description: "New text to replace the old text with",
    }),
  },
  { additionalProperties: false },
);

const multiEditSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Path to the file to edit (relative or absolute). Required for classic mode and for the edits batch parameter.",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description: "Exact text to find and replace (must match exactly)",
    }),
  ),
  newText: Type.Optional(
    Type.String({ description: "New text to replace the old text with" }),
  ),
  multi: Type.Optional(
    Type.Array(multiEditItemSchema, {
      description:
        "Multi-file batch edits. Each item MUST include its own path. Mutually exclusive with edits.",
    }),
  ),
  edits: Type.Optional(
    Type.Array(singleEditItemSchema, {
      description:
        "Single-file batch edits within the file specified by the top-level path. Mutually exclusive with multi.",
    }),
  ),
  patch: Type.Optional(
    Type.String({
      description:
        "Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with oldText/newText/multi/edits.",
    }),
  ),
});

function clampDiff(diff: string | undefined, maxLines = 200): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join("\n") + "\n... (diff truncated)";
}

function shortenPath(p: string | undefined): string {
  if (!p) return "...";
  const home = typeof process !== "undefined" ? process.env.HOME || process.env.USERPROFILE : "";
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

interface RenderCtx {
  isPartial: boolean;
  executionStarted: boolean;
  isError: boolean;
}

function makePlainText(text: string) {
  return {
    render(width: number): string[] {
      return text ? [truncateToWidth(text, width, "...")] : [];
    },
    invalidate() {},
  };
}

function makeWrappedText(lines: string[]) {
  return {
    render(width: number): string[] {
      return lines.map((line) => truncateToWidth(line, width, "..."));
    },
    invalidate() {},
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      `Edit files by replacing exact text. Four modes:
      1) Classic: single file, single replacement (path + oldText + newText).
      2) Single-file batch: top-level path + edits array of {oldText, newText} for many changes in one file.
      3) Multi-file batch: multi array of {path, oldText, newText} for changes across many files.
      4) Patch: a patch string in Codex format for complex multi-file changes.

      Batch and patch edits are atomic: if any individual edit fails, all changes are rolled back and no files are modified. oldText must match exactly including whitespace.`,
    promptSnippet:
      "Edit files with exact replacement. Use edits for single-file batches, multi for multi-file batches, and patch for Codex-style patches.",
    promptGuidelines: [
      "For a single replacement use path + oldText + newText",
      "For multiple replacements in the SAME file use top-level path + the edits array",
      "For multiple replacements across DIFFERENT files use the multi array; each item MUST have its own path",
      "multi and edits are mutually exclusive; never use both in one call",
      "The patch parameter is mutually exclusive with oldText/newText/multi/edits",
      "oldText must match exactly including whitespace, quotes, and trailing spaces",
      "Patch: wrap in *** Begin Patch ... *** End Patch. Use *** Update File:, *** Add File:, *** Delete File:",
      "Patch @@ marker must contain a line of CONTEXT that appears BEFORE the change, never the changed line itself",
      "Patch lines: '-' removes the exact file line, '+' adds a new line, ' ' is optional unchanged context",
      "To insert new code without removing old lines, use @@ with context followed by only '+' lines",
      "Correct: @@ function setup() {\\n-    const x = 1;\\n+    const x = 2; | Wrong: @@ -    const x = 1;\\n-    const x = 1;",
    ],
    parameters: multiEditSchema,
    renderShell: "self",

    renderCall(args: any, theme: any, context: RenderCtx) {
      const count =
        args.patch ? "patch" :
        Array.isArray(args.multi) ? `${args.multi.length} file${args.multi.length === 1 ? "" : "s"}` :
        Array.isArray(args.edits) ? `${args.edits.length} change${args.edits.length === 1 ? "" : "s"}` :
        "1 change";
      const target = shortenPath(args.path || (Array.isArray(args.multi) && args.multi[0]?.path) || undefined);
      const label = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", target)} ${theme.fg("dim", `(${count})`)}`;
      return makePlainText(label);
    },

    renderResult(result: any, options: any, _theme: any, _context: any) {
      if (options.isPartial) {
        return makePlainText("");
      }

      // Prefer diff from details; fall back to content text
      const diff = result.details?.diff;
      if (typeof diff === "string" && diff.trim()) {
        const lines = clampDiff(diff).split("\n");
        return makeWrappedText(lines);
      }

      const text = result.content?.[0]?.text;
      if (typeof text === "string" && text.trim()) {
        return makeWrappedText(text.split("\n"));
      }

      return makePlainText("");
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { path, oldText, newText, multi, edits: rawEdits, patch } = params;

      const p = path ?? undefined;
      const o = oldText ?? undefined;
      const n = newText ?? undefined;
      const m = Array.isArray(multi) ? multi : undefined;
      const e = Array.isArray(rawEdits) ? rawEdits : undefined;
      const pa = patch ?? undefined;

      if (m !== undefined && e !== undefined) {
        throw new Error(
          "Cannot use both `multi` and `edits` in the same call. Use `multi` for multi-file edits and `edits` for single-file batch edits.",
        );
      }

      const hasAnyClassicParam = o !== undefined || n !== undefined || m !== undefined || e !== undefined;
      if (pa !== undefined && hasAnyClassicParam) {
        throw new Error(
          "The `patch` parameter is mutually exclusive with oldText/newText/multi/edits.",
        );
      }

      if (pa !== undefined) {
        const ops = parsePatch(pa);

        await applyPatchOperations(
          ops,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false },
        );

        const applied = await applyPatchOperations(
          ops,
          createRealWorkspace(),
          ctx.cwd,
          signal,
          { collectDiff: true, rollbackOnError: true },
        );
        const summary = applied
          .map((r, i) => `${i + 1}. ${r.message}`)
          .join("\n");
        const combinedDiff = clampDiff(
          applied
            .filter((r) => r.diff)
            .map((r) => `File: ${r.path}\n${r.diff}`)
            .join("\n\n"),
        );
        const firstChangedLine = applied.find(
          (r) => r.firstChangedLine !== undefined,
        )?.firstChangedLine;
        return {
          content: [
            {
              type: "text" as const,
              text: `Applied patch with ${applied.length} operation(s).\n${summary}`,
            },
          ],
          details: {
            diff: combinedDiff,
            firstChangedLine,
          },
        };
      }

      const edits: EditItem[] = [];
      const hasTopLevelSingle = p !== undefined && o !== undefined && n !== undefined;

      if (hasTopLevelSingle) {
        edits.push({ path: p as string, oldText: o as string, newText: n as string });
      } else if (p !== undefined || o !== undefined || n !== undefined) {
        const hasOnlyPath = p !== undefined && o === undefined && n === undefined;
        if (!hasOnlyPath || (m === undefined && e === undefined)) {
          const missing: string[] = [];
          if (p === undefined) missing.push("path");
          if (o === undefined) missing.push("oldText");
          if (n === undefined) missing.push("newText");
          throw new Error(
            `Incomplete top-level edit: missing ${missing.join(", ")}. ` +
            `Received: path=${typeof p}, oldText=${typeof o}, newText=${typeof n}, multi=${Array.isArray(m)}, edits=${Array.isArray(e)}. ` +
            `Provide all three (path, oldText, newText) or use multi/edits.`,
          );
        }
      }

      if (e) {
        if (!p) {
          throw new Error(
            "The `edits` parameter requires a top-level `path`. Set the target file path.",
          );
        }
        for (const item of e) {
          edits.push({ path: p, oldText: item.oldText, newText: item.newText });
        }
      }

      if (m) {
        for (const item of m) {
          edits.push({
            path: item.path,
            oldText: item.oldText,
            newText: item.newText,
          });
        }
      }

      if (edits.length === 0) {
        throw new Error(
          "No edits provided. Supply path/oldText/newText, a multi array, an edits array, or a patch.",
        );
      }

      for (let i = 0; i < edits.length; i++) {
        if (!edits[i].path) {
          throw new Error(
            `Edit ${i + 1} is missing a path.`,
          );
        }
      }

      try {
        const preflightResults = await applyClassicEdits(
          edits,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false, continueOnError: true },
        );
        const preflightFails = preflightResults.filter((r) => !r.success);
        if (preflightFails.length > 0) {
          throw new Error(
            `Preflight failed — ${preflightFails.length}/${edits.length} edit(s) could not be matched. No files were modified.\n` +
            formatResults(preflightResults, edits.length),
          );
        }
      } catch (err: any) {
        throw new Error(
          `Preflight failed before mutating files.\n${err.message ?? String(err)}`,
        );
      }

      const results = await applyClassicEdits(
        edits,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        {
          collectDiff: true,
          rollbackOnError: true,
        },
      );

      const succeeded = results.filter((r) => r?.success);
      const failed = results.filter((r) => r && !r.success);

      if (results.length === 1) {
        const r = results[0];
        return {
          content: [{ type: "text" as const, text: r.message }],
          details: {
            diff: clampDiff(r.diff ?? ""),
            firstChangedLine: r.firstChangedLine,
          },
        };
      }

      const combinedDiff = clampDiff(
        results
          .filter((r) => r?.diff)
          .map((r) => `File: ${r.path}\n${r.diff}`)
          .join("\n\n"),
      );

      const firstChanged = results.find(
        (r) => r?.firstChangedLine !== undefined,
      )?.firstChangedLine;
      const summary = results
        .map((r, i) => `${i + 1}. ${r.message}`)
        .join("\n");

      const statusLine =
        failed.length > 0
          ? `Applied ${succeeded.length}/${results.length} edit(s). ${failed.length} failed:\n${summary}`
          : `Applied ${results.length} edit(s) successfully.\n${summary}`;

      return {
        content: [{ type: "text" as const, text: statusLine }],
        details: {
          diff: combinedDiff,
          firstChangedLine: firstChanged,
        },
      };
    },
  });
}
