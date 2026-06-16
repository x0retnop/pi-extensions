import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyEdits } from "./engine.js";
import { buildPreflightError, buildSuccessResponse } from "./messages.js";
import { editParameters, parseEdits, prepareArguments } from "./params.js";
import {
  formatCallHeader,
  formatResultLines,
  makeTextComponent,
} from "./render.js";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Exact text replacement in files. Always set path (top-level) for single-file edits — same as native edit. " +
      "Shape: {path, edits:[{oldText,newText},...]}. Also: {path, oldText, newText} or multi:[{path,oldText,newText},...]. " +
      "Each oldText matches the original file. Atomic preflight.",
    promptSnippet:
      "Single/batch: top-level path + edits[]. Multi-file: path on each edit (or multi[]). path is separate from oldText.",
    promptGuidelines: [
      "Always set top-level path for single-file edits — path is a separate field, not inside oldText",
      "Preferred shape: top-level path + edits[{oldText,newText}, ...]",
      "Batch related changes in one edits[] call instead of many single-edit calls",
      "Single edit shortcut: top-level path + oldText + newText",
      "Multi-file: edits[{path,oldText,newText}, ...] or multi[{path,oldText,newText}, ...]",
      "Each oldText matches the current file — re-read after restructuring code (moving lines into functions, etc.)",
      "Exact match: ' vs \" and indentation must match; on failure re-read, fix oldText, retry the whole call",
    ],
    parameters: editParameters,
    prepareArguments,

    renderShell: "self",

    renderCall(args: any, theme: any) {
      return makeTextComponent(() => [formatCallHeader(args ?? {}, theme)]);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      const lines = formatResultLines(result, context, theme, !!options?.isPartial);
      return makeTextComponent(() => lines);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const edits = parseEdits(params as Record<string, unknown>);

      const preflight = await applyEdits(
        edits,
        createVirtualWorkspace(ctx.cwd),
        ctx.cwd,
        signal,
        { preflight: true, continueOnError: true },
      );

      const fails = preflight.filter((r) => !r.success);
      if (fails.length > 0) {
        throw new Error(buildPreflightError(preflight, edits.length, edits.length > 1));
      }

      const results = await applyEdits(
        edits,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { collectDiff: true },
      );

      return buildSuccessResponse(results, edits);
    },
  });
}