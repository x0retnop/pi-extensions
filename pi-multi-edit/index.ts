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
import {
  formatCallHeader,
  formatResultLine,
  makeCallComponent,
  makeResultComponent,
  shellState,
} from "./render.js";
import type { EditResult } from "./types.js";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.js";

function renderErrorText(result: any): string {
  return result instanceof Error
    ? result.message
    : result?.content?.[0]?.text ?? "failed";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Replace one exact block. old_string must be unique unless replace_all. " +
      "A same-turn read of this path can be stale; re-read before the next edit. " +
      "Several changes in one file: multi_edit. Different files: parallel edit calls.",
    parameters: singleEditParameters,

    renderShell: "self",

    renderCall(args: any, theme: any, context: any) {
      return makeCallComponent(formatCallHeader("edit", args ?? {}, theme), shellState(context), theme);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      if (context?.isError) {
        return makeResultComponent(theme.fg("error", renderErrorText(result)), "error", theme);
      }
      return makeResultComponent(formatResultLine(result?.details, theme), shellState(context, options), theme);
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
      "Edits are applied sequentially. If some edits fail, the successful ones are still applied and failures are reported per edit. " +
      "Re-read the file immediately before editing; prefer edit for a single change.",
    parameters: multiEditParameters,

    renderShell: "self",

    renderCall(args: any, theme: any, context: any) {
      return makeCallComponent(formatCallHeader("multi_edit", args ?? {}, theme), shellState(context), theme);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      if (context?.isError) {
        return makeResultComponent(theme.fg("error", renderErrorText(result)), "error", theme);
      }
      return makeResultComponent(formatResultLine(result?.details, theme), shellState(context, options), theme);
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
      "Insert lines before insert_line. To replace text, use edit.",
    parameters: insertParameters,

    renderShell: "self",

    renderCall(args: any, theme: any, context: any) {
      return makeCallComponent(formatCallHeader("insert", args ?? {}, theme), shellState(context), theme);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      if (context?.isError) {
        return makeResultComponent(theme.fg("error", renderErrorText(result)), "error", theme);
      }
      return makeResultComponent(formatResultLine(result?.details, theme), shellState(context, options), theme);
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
