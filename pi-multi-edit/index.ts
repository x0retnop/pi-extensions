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
      "Atomic exact text replacement. Two modes: " +
      "(1) single edit: {path, oldText, newText}; " +
      "(2) batch edit: {path, edits:[{oldText, newText}, ...]}. " +
      "oldText must match exactly. newText \"\" deletes the matched block. " +
      "By default batch edits are atomic; set partialApply:true to apply matching edits and report failures separately.",
    promptSnippet:
      'Single edit: {\"path\":\"src/app.py\",\"oldText\":\"foo\",\"newText\":\"bar\"}. ' +
      'Batch edit: {\"path\":\"src/app.py\",\"edits\":[{\"oldText\":\"foo\",\"newText\":\"bar\"},{\"oldText\":\"baz\",\"newText\":\"qux\"}]}.',
    promptGuidelines: [
      "Use `edits[]` for multiple changes in the same file; top-level `path` is required",
      'Example batch: {\"path\":\"src/app.py\",\"edits\":[{\"oldText\":\"foo\",\"newText\":\"bar\"},{\"oldText\":\"baz\",\"newText\":\"qux\"}]}',
      "PREFER batching multiple same-file changes into one `edits[]` call instead of many separate `edit` calls",
      "NEVER send multiple separate `edit` calls for the same file — batch them",
      "`path` is always a top-level or per-item field; NEVER put `path` inside `oldText` or `newText`",
      "oldText MUST match exactly including indentation (tabs vs spaces), quotes (' vs \"), backticks, and trailing whitespace. Copy verbatim from `read` output",
      "After a successful `edit` the file is stale. Before sending another `edit` to the same file, re-read the current section and rebuild `oldText` from fresh output. Do not reuse old `oldText` from a previous call",
      "If preflight fails: STOP, re-read the exact current block, fix `oldText` from fresh output, then retry the WHOLE call. Do NOT patch `oldText` from memory or split the batch into separate calls",
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