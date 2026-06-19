import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyEdits } from "./engine.js";
import {
  buildPartialErrorResponse,
  buildPreflightError,
  buildSuccessResponse,
} from "./messages.js";
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
      "Atomic exact text replacement. Three mutually exclusive modes: " +
      "(1) single edit: {path, oldText, newText}; " +
      "(2) same-file batch: {path, edits:[{oldText, newText}, ...]}; " +
      "(3) multi-file batch: {multi:[{path, oldText, newText}, ...]}. " +
      "oldText must match exactly. newText \"\" deletes the matched block. " +
      "By default batch edits are atomic; set partialApply:true to apply matching edits and report failures separately.",
    promptSnippet:
      'Single edit: {\"path\":\"src/app.py\",\"oldText\":\"foo\",\"newText\":\"bar\"}. ' +
      'Same file: {\"path\":\"src/app.py\",\"edits\":[{\"oldText\":\"foo\",\"newText\":\"bar\"},{\"oldText\":\"baz\",\"newText\":\"qux\"}]}. ' +
      'Several files: {\"multi\":[{\"path\":\"a.py\",\"oldText\":\"x\",\"newText\":\"y\"},{\"path\":\"b.py\",\"oldText\":\"p\",\"newText\":\"q\"}]}.',
    promptGuidelines: [
      "Use `edits[]` ONLY for multiple changes in the SAME file; top-level `path` is required",
      'Example same-file batch: {\"path\":\"src/app.py\",\"edits\":[{\"oldText\":\"foo\",\"newText\":\"bar\"},{\"oldText\":\"baz\",\"newText\":\"qux\"}]}',
      "Use `multi[]` ONLY when editing DIFFERENT files in one call; each item MUST have its own `path`",
      'Example multi-file batch: {\"multi\":[{\"path\":\"a.py\",\"oldText\":\"x\",\"newText\":\"y\"},{\"path\":\"b.py\",\"oldText\":\"p\",\"newText\":\"q\"}]}',
      "`edits[]` and `multi[]` are mutually exclusive — never use both in one call",
      "PREFER batching multiple same-file changes into one `edits[]` call instead of many separate `edit` calls",
      "NEVER send multiple separate `edit` calls for the same file — batch them",
      "`path` is always a top-level or per-item field; NEVER put `path` inside `oldText` or `newText`",
      "oldText MUST match exactly including indentation (tabs vs spaces), quotes (' vs \"), backticks, and trailing whitespace. Copy verbatim from `read` output",
      "If preflight fails: re-read the exact current block, fix oldText, then retry the WHOLE call. Do NOT split the batch into separate calls",
      "Set `partialApply:true` when batch edits are INDEPENDENT — matching edits will be applied and only failures are reported separately",
      "When `partialApply:true` is used, retry only the failed edits after re-reading the current file",
      'To delete a block: set newText to "" and oldText to the exact block including trailing newlines',
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
      const { edits, partialApply } = parseEdits(params as Record<string, unknown>);

      const preflight = await applyEdits(
        edits,
        createVirtualWorkspace(ctx.cwd),
        ctx.cwd,
        signal,
        { preflight: true, continueOnError: true },
      );

      const fails = preflight.filter((r) => !r.success);
      const isBatch = edits.length > 1;

      if (fails.length > 0 && !partialApply) {
        throw new Error(buildPreflightError(preflight, edits.length, isBatch));
      }

      const results = await applyEdits(
        edits,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { collectDiff: true, continueOnError: partialApply },
      );

      const failedResults = results.filter((r) => !r.success);
      if (partialApply && failedResults.length > 0) {
        return buildPartialErrorResponse(results, edits);
      }

      return buildSuccessResponse(results, edits);
    },
  });
}