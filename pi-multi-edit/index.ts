import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { applyClassicEdits, formatResults } from "./classic.js";
import { applyPatchOperations, parsePatch } from "./patch.js";
import type { EditItem } from "./types.ts";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.js";

const editItemSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted.",
    }),
  ),
  oldText: Type.String({
    description: "Exact text to find and replace (must match exactly)",
  }),
  newText: Type.String({
    description: "New text to replace the old text with",
  }),
});

const multiEditSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Path to the file to edit (relative or absolute)",
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
    Type.Array(editItemSchema, {
      description:
        "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
    }),
  ),
  edits: Type.Optional(
    Type.Array(editItemSchema, {
      description:
        "Alias for multi. Batch edits array used by some callers.",
    }),
  ),
  patch: Type.Optional(
    Type.String({
      description:
        "Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with oldText/newText/multi/edits.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      `Edit files by replacing exact text. Three modes:
      1) Classic: single file, single replacement (path + oldText + newText).
      2) Batch: pass a "multi" (or "edits") array of {path?, oldText, newText} edits. Use this automatically when more than one edit is needed — it reduces round-trips and pre-validates everything before writing.
      3) Patch: pass a "patch" string in Codex format for complex multi-file changes. Mutually exclusive with oldText/newText/multi/edits.

      Batch and patch edits are atomic: if any individual edit fails, all changes are rolled back and no files are modified. oldText must match exactly including whitespace.`,
    promptSnippet:
      "Edit files with exact replacement. Use multi for any batch of edits and patch for Codex-style patches.",
    promptGuidelines: [
      "If you have more than one edit, always use the multi parameter instead of multiple separate edit calls",
      "When most edits target the same file, set a top-level path and omit path inside individual multi items",
      "The patch parameter is mutually exclusive with oldText/newText/multi/edits; edits is an alias for multi",
      "oldText must match exactly including whitespace, quotes, and trailing spaces",
      "Patch: wrap in *** Begin Patch ... *** End Patch. Use *** Update File:, *** Add File:, *** Delete File:",
      "Patch @@ marker must contain a line of CONTEXT that appears BEFORE the change, never the changed line itself",
      "Patch lines: '-' removes the exact file line, '+' adds a new line, ' ' is optional unchanged context",
      "To insert new code without removing old lines, use @@ with context followed by only '+' lines",
      "Correct: @@ function setup() {\\n-    const x = 1;\\n+    const x = 2; | Wrong: @@ -    const x = 1;\\n-    const x = 1;",
    ],
    parameters: multiEditSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { path, oldText, newText, multi, edits: rawEdits, patch } = params;

      // Support both "multi" (preferred) and "edits" (system API alias).
      const rawMulti = multi ?? rawEdits;

      // Defensive: treat both null and undefined as absent.
      const p = path ?? undefined;
      const o = oldText ?? undefined;
      const n = newText ?? undefined;
      const m = Array.isArray(rawMulti) ? rawMulti : undefined;
      const pa = patch ?? undefined;

      const hasAnyClassicParam = o !== undefined || n !== undefined || m !== undefined;
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
        const combinedDiff = applied
          .filter((r) => r.diff)
          .map((r) => `File: ${r.path}\n${r.diff}`)
          .join("\n\n");
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
      const hasTopLevel = p !== undefined && o !== undefined && n !== undefined;

      if (hasTopLevel) {
        edits.push({ path: p as string, oldText: o as string, newText: n as string });
      } else if (p !== undefined || o !== undefined || n !== undefined) {
        const hasOnlyPath = p !== undefined && o === undefined && n === undefined;
        if (!hasOnlyPath || m === undefined) {
          const missing: string[] = [];
          if (p === undefined) missing.push("path");
          if (o === undefined) missing.push("oldText");
          if (n === undefined) missing.push("newText");
          throw new Error(
            `Incomplete top-level edit: missing ${missing.join(", ")}. ` +
            `Received: path=${typeof p}, oldText=${typeof o}, newText=${typeof n}, multi=${Array.isArray(m)}. ` +
            `Provide all three (path, oldText, newText) or use only the multi/edits parameter.`,
          );
        }
      }

      if (m) {
        for (const item of m) {
          edits.push({
            path: item.path ?? p ?? "",
            oldText: item.oldText,
            newText: item.newText,
          });
        }
      }

      if (edits.length === 0) {
        throw new Error(
          "No edits provided. Supply path/oldText/newText, a multi/edits array, or a patch.",
        );
      }

      for (let i = 0; i < edits.length; i++) {
        if (!edits[i].path) {
          throw new Error(
            `Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
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
            diff: r.diff ?? "",
            firstChangedLine: r.firstChangedLine,
          },
        };
      }

      const combinedDiff = results
        .filter((r) => r?.diff)
        .map((r) => `File: ${r.path}\n${r.diff}`)
        .join("\n\n");

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
