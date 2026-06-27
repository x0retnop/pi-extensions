import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { executeMultiEdit, executeSingleEdit } from "./engine.js";
import {
  buildMultiError,
  buildMultiSuccess,
  buildSingleError,
  buildSingleSuccess,
} from "./messages.js";
import {
  multiEditParameters,
  parseMultiEdit,
  parseSingleEdit,
  singleEditParameters,
} from "./params.js";
import { formatCallHeader, makeTextComponent } from "./render.js";
import type { EditResult } from "./types.js";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.js";

const EDIT_PROMPT_SNIPPET =
  'Single replacement: {"path":"src/app.py","old_string":"foo","new_string":"bar"}. ' +
  'To delete a block, set new_string to "".';

const EDIT_GUIDELINES = [
  "Use edit for a single replacement in one file.",
  "old_string must match exactly including indentation, tabs, quotes, and trailing whitespace. Copy verbatim from read output.",
  "If old_string appears more than once, either make it unique with more context or set replace_all: true.",
  "For multiple independent edits in the same file, use multi_edit; do not chain several edit calls to the same file in one turn.",
  "After a successful edit, the file is stale. Before calling edit again, re-read the current section and rebuild old_string from fresh output.",
];

const MULTI_EDIT_PROMPT_SNIPPET =
  'Batch replacement: {"path":"src/app.py","edits":[{"old_string":"foo","new_string":"bar"},{"old_string":"baz","new_string":"qux"}]}.';

const MULTI_EDIT_GUIDELINES = [
  "Use multi_edit for several independent replacements in ONE file.",
  "Edits are applied sequentially: edits[1] sees the file after edits[0] is applied.",
  "Each old_string must be unique in the current file state unless replace_all is true for that edit.",
  "If any edit fails, the whole batch is aborted unless the tool supports partial apply.",
  "Prefer edit (single) for one change; prefer multi_edit only when the changes are in different, non-overlapping parts of the file.",
];

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Replace a single block of text in a file. " +
      "Provide path, old_string (exact text to find), and new_string (replacement). " +
      "Set replace_all: true to replace every occurrence.",
    promptSnippet: EDIT_PROMPT_SNIPPET,
    promptGuidelines: EDIT_GUIDELINES,
    parameters: singleEditParameters,

    renderShell: "self",

    renderCall(args: any, theme: any) {
      return makeTextComponent(() => [formatCallHeader("edit", args ?? {}, theme)]);
    },

    renderResult(result: any, _options: any, theme: any, context: any) {
      return makeTextComponent(() => {
        if (context?.isError) {
          const text = result?.content?.[0]?.text ?? "failed";
          return text.split("\n").map((line: string) => theme.fg("error", line));
        }
        return [theme.fg("dim", "done")];
      });
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const edit = parseSingleEdit(params);

      // Preflight: virtual workspace catches mismatches before writing.
      const preflight = await executeSingleEdit(
        edit,
        createVirtualWorkspace(ctx.cwd),
        ctx.cwd,
        signal,
        { preflight: true },
      );
      if (!preflight.result.success) {
        buildSingleError(edit.path, preflight.result.message);
      }

      const { result, changed } = await executeSingleEdit(
        edit,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { preflight: false },
      );

      if (!result.success) {
        buildSingleError(edit.path, result.message);
      }

      return buildSingleSuccess(result, result.stats, result.firstChangedLine);
    },
  });

  pi.registerTool({
    name: "multi_edit",
    label: "multi_edit",
    description:
      "Apply multiple independent text replacements in a single file. " +
      "Provide path and edits: [{old_string, new_string, replace_all?}, ...]. " +
      "Edits are applied sequentially. If any edit fails, the whole batch is aborted.",
    promptSnippet: MULTI_EDIT_PROMPT_SNIPPET,
    promptGuidelines: MULTI_EDIT_GUIDELINES,
    parameters: multiEditParameters,

    renderShell: "self",

    renderCall(args: any, theme: any) {
      return makeTextComponent(() => [formatCallHeader("multi_edit", args ?? {}, theme)]);
    },

    renderResult(result: any, _options: any, theme: any, context: any) {
      return makeTextComponent(() => {
        if (context?.isError) {
          const text = result?.content?.[0]?.text ?? "failed";
          return text.split("\n").map((line: string) => theme.fg("error", line));
        }
        return [theme.fg("dim", "done")];
      });
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const multi = parseMultiEdit(params);

      // Preflight: virtual workspace catches mismatches before writing.
      const preflight = await executeMultiEdit(
        multi,
        createVirtualWorkspace(ctx.cwd),
        ctx.cwd,
        signal,
        { preflight: true },
      );
      const failedPreflights = preflight.results.filter((r) => !r.success);
      if (failedPreflights.length > 0) {
        buildMultiError(multi.path, preflight.results);
      }

      const { results, changed } = await executeMultiEdit(
        multi,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { preflight: false },
      );

      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        buildMultiError(multi.path, results);
      }

      const stats = changed
        ? results.find((r) => r.stats)?.stats
        : undefined;
      const firstChangedLine = changed
        ? results.find((r) => r.firstChangedLine)?.firstChangedLine
        : undefined;

      return buildMultiSuccess(multi.path, results, stats, firstChangedLine);
    },
  });
}
