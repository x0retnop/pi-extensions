import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { executeInsert, executeMultiEdit, executeSingleEdit } from "./engine.js";
import {
  buildInsertError,
  buildInsertSuccess,
  buildMultiError,
  buildMultiSuccess,
  buildSingleError,
  buildSingleSuccess,
} from "./messages.js";
import {
  insertParameters,
  multiEditParameters,
  parseInsert,
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
  "For edits in different files, emit several parallel edit calls in the same turn.",
  "For multiple independent edits in the same file, use multi_edit; do not chain several edit calls to the same file in one turn.",
  "After a successful edit, the file is stale. Before calling edit again, re-read the current section and rebuild old_string from fresh output.",
];

const MULTI_EDIT_PROMPT_SNIPPET =
  'Batch replacement: {"path":"src/app.py","edits":[{"old_string":"foo","new_string":"bar"},{"old_string":"baz","new_string":"qux"}]}.';

const MULTI_EDIT_GUIDELINES = [
  "Use multi_edit for several independent replacements in ONE file.",
  "Keep batches small — up to 3 edits is ideal. Larger batches are accepted, but smaller ones are easier to fix when one edit fails.",
  "Re-read the file immediately before multi_edit. old_string must be copied verbatim from the current file.",
  "Edits are applied sequentially: edits[1] sees the file after edits[0] is applied.",
  "Each old_string must be unique in the current file state unless replace_all is true for that edit.",
  "If some edits fail, the successful ones are still applied (partial apply). The result shows ✓/✗ per edit with a hint for each failure; re-read the file and retry only the failed ones.",
  "Prefer edit (single) for one change; prefer multi_edit only when the changes are in different, non-overlapping parts of the file.",
];

const INSERT_PROMPT_SNIPPET =
  'Insert text: {"path":"src/app.py","insert_line":42,"new_string":"    new_line();"}. ' +
  "insert_line is 1-indexed; use 1 to prepend, line_count+1 to append.";

const INSERT_GUIDELINES = [
  "Use insert to add one or more lines before a specific line number.",
  "insert_line is 1-indexed. Use 1 to insert at the top of the file.",
  "To append at the end, set insert_line to the number of lines plus one.",
  "For replacing existing text, use edit instead.",
];

function renderError(result: any, theme: any) {
  const text =
    result instanceof Error
      ? result.message
      : result?.content?.[0]?.text ?? "failed";
  return text.split("\n").map((line: string) => theme.fg("error", line));
}

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
          return renderError(result, theme);
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
        return buildSingleError(edit.path, preflight.result.message);
      }

      const { result } = await executeSingleEdit(
        edit,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { preflight: false },
      );

      if (!result.success) {
        return buildSingleError(edit.path, result.message);
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
      "Edits are applied sequentially. If some edits fail, the successful ones are still applied and failures are reported per edit.",
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
          return renderError(result, theme);
        }
        return [theme.fg("dim", "done")];
      });
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const multi = parseMultiEdit(params);

      // Partial apply: successful edits are written even if others fail.
      const { results, changed } = await executeMultiEdit(
        multi,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { preflight: false, continueOnError: true },
      );

      const failed = results.filter((r: EditResult) => !r.success);
      if (failed.length > 0 && !changed) {
        // Nothing matched at all — no write happened, report as a full error.
        return buildMultiError(multi.path, results);
      }

      const stats = changed ? results.find((r: EditResult) => r.stats)?.stats : undefined;
      const firstChangedLine = changed
        ? results.find((r: EditResult) => r.firstChangedLine)?.firstChangedLine
        : undefined;

      return buildMultiSuccess(multi.path, results, stats, firstChangedLine);
    },
  });

  pi.registerTool({
    name: "insert",
    label: "insert",
    description:
      "Insert one or more lines before a specific line in a file. " +
      "Provide path, insert_line (1-indexed), and new_string.",
    promptSnippet: INSERT_PROMPT_SNIPPET,
    promptGuidelines: INSERT_GUIDELINES,
    parameters: insertParameters,

    renderShell: "self",

    renderCall(args: any, theme: any) {
      return makeTextComponent(() => [formatCallHeader("insert", args ?? {}, theme)]);
    },

    renderResult(result: any, _options: any, theme: any, context: any) {
      return makeTextComponent(() => {
        if (context?.isError) {
          return renderError(result, theme);
        }
        return [theme.fg("dim", "done")];
      });
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const edit = parseInsert(params);

      const preflight = await executeInsert(
        edit,
        createVirtualWorkspace(ctx.cwd),
        ctx.cwd,
        signal,
        { preflight: true },
      );
      if (!preflight.result.success) {
        return buildInsertError(edit.path, preflight.result.message);
      }

      const { result } = await executeInsert(
        edit,
        createRealWorkspace(),
        ctx.cwd,
        signal,
        { preflight: false },
      );

      if (!result.success) {
        return buildInsertError(edit.path, result.message);
      }

      return buildInsertSuccess(result, result.stats, result.firstChangedLine);
    },
  });
}
