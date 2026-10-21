import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { statSync, appendFileSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { writeTextPreservingBom, type WriteOutcome } from "./persist.js";
import {
  contentOf,
  formatWriteHeader,
  formatWriteResult,
  matchRecentPath,
  pathOf,
  syncWriteTimer,
  writeCallComponent,
  writeResultComponent,
  type WriteRowState,
} from "./render.js";

/**
 * write-mode — `write` override: native schema and file semantics, our own execution, one-line row.
 *
 * Name, description (plus the guideline Pi puts in a field this host never sends), parameters and
 * constrained sampling come from Pi's own definition, and the file work stays Pi's: resolved through
 * its own path rules, serialized per absolute path by its mutation queue, aborted the same way. Two
 * things are ours (see ./persist.ts for the measurements): the target keeps its BOM, and the result
 * the model reads carries the size instead of the bare `Successfully wrote to <path>`.
 *
 * Schema wording was tried here and dropped: asking the model to emit `path` first does not work
 * (docs/extensions/write-mode.md §"The filename appears when the model emits it"). Do not re-add
 * prompt text to this tool hoping to steer key order — and no new parameters: across 1071 calls the
 * model never passed a single argument outside `path`/`content`.
 */

const originalWrite = createWriteToolDefinition(process.cwd());

/**
 * Final arguments per tool call, captured when the call executes.
 *
 * The row's arguments come from the stream (`message_update` → `updateArgs`) and Pi never refreshes
 * them afterwards: `tool_execution_start` discards `event.args` for a row that already exists, and
 * `message_end` only flips `argsComplete`. So a row whose last streamed delta was short of the tail
 * (the `path`, for every model that emits `content` first) keeps those partial args forever — the
 * settled header then reads `write ... 2.4k, 96 lines`. Execution always has the real args, so the
 * settled render takes them from here — and keeps them: the row is re-rendered long after it settles
 * (resize, Ctrl+O), and `renderResult` must not drop the entry, or the path falls back to the
 * content-prefix ring and disappears from the row once `RECENT_LIMIT` further writes evict it. The map
 * is bounded by `FINAL_ARGS_LIMIT` instead, oldest first.
 */
const finalArgs = new Map<string, Record<string, unknown>>();
/** Recent executed writes, for rows whose id never matched (stale/ghost row from a mutated id). */
const recentWrites: Array<{ path: string; content: string }> = [];
const RECENT_LIMIT = 8;
const FINAL_ARGS_LIMIT = 32;

/** Diagnostics for a rendering report: set PI_WRITE_TRACE=1 before starting Pi. */
const TRACE = process.env.PI_WRITE_TRACE === "1";
const TRACE_PATH = join(homedir(), ".pi", "agent", "logs", "write-mode-trace.jsonl");

function trace(entry: Record<string, unknown>): void {
  if (!TRACE) return;
  try {
    mkdirSync(dirname(TRACE_PATH), { recursive: true });
    appendFileSync(TRACE_PATH, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, "utf-8");
  } catch {
    /* tracing must never break a render */
  }
}

function rememberWrite(args: Record<string, unknown>): void {
  const path = pathOf(args);
  if (!path) return;
  recentWrites.push({ path, content: contentOf(args) });
  if (recentWrites.length > RECENT_LIMIT) recentWrites.shift();
}

/** Args to render with: the executed ones when known, else the streamed ones (path patched if we can). */
function rowArgs(toolCallId: string, streamed: Record<string, unknown> | undefined): {
  args: Record<string, unknown> | undefined;
  source: "final" | "stream" | "match";
  path?: string;
} {
  const final = finalArgs.get(toolCallId);
  if (final) return { args: final, source: "final", path: pathOf(final) };
  const streamedPath = pathOf(streamed);
  if (streamedPath) return { args: streamed, source: "stream", path: streamedPath };
  const matched = matchRecentPath(recentWrites, contentOf(streamed));
  if (matched) return { args: streamed, source: "match", path: matched };
  return { args: streamed, source: "stream" };
}

/**
 * Size of the file as it is *before* this write. Read once, while the args are complete but the tool
 * has not started — after that the stat would return the new size and the row would read
 * `2.4k → 2.4k`. null = the file did not exist.
 */
function preWriteSize(
  state: WriteRowState,
  args: Record<string, unknown> | undefined,
  cwd: string,
  mayRead: boolean,
): number | null | undefined {
  if (state.oldChecked || !mayRead) return state.oldBytes;
  const raw = args?.path ?? args?.file_path;
  if (typeof raw !== "string" || !raw) return state.oldBytes;
  state.oldChecked = true;
  try {
    const stats = statSync(resolve(cwd, raw));
    state.oldBytes = stats.isFile() ? stats.size : null;
  } catch {
    state.oldBytes = null;
  }
  return state.oldBytes;
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

const definition: ToolDefinition<typeof originalWrite.parameters, undefined, WriteRowState> = {
  name: "write",
  label: "write",
  // Pi's guideline for this tool lives in `promptGuidelines`, which never reaches the model on this
  // host (custom prompt — docs/pi-tool-internals.md §3), so it moves into the description verbatim.
  description: `${originalWrite.description} Use write only for new files or complete rewrites; use edit for changes.`,
  parameters: originalWrite.parameters,
  constrainedSampling: originalWrite.constrainedSampling,
  renderShell: "default",

  renderCall(args, theme, context) {
    const state: WriteRowState = (context.state ??= {});
    const resolved = rowArgs(context.toolCallId, args);
    const elapsedMs = syncWriteTimer(state, {
      running: context.isPartial,
      invalidate: context.invalidate,
    });
    const oldBytes = preWriteSize(
      state,
      resolved.args,
      context.cwd,
      context.argsComplete && !context.executionStarted,
    );
    trace({
      ev: "call",
      id: context.toolCallId,
      src: resolved.source,
      keys: Object.keys(args ?? {}),
      path: resolved.path ?? null,
      chars: contentOf(resolved.args).length,
      partial: context.isPartial,
      complete: context.argsComplete,
    });
    return writeCallComponent(
      formatWriteHeader(resolved.args, theme, {
        elapsedMs,
        oldBytes,
        path: resolved.path,
        settled: !context.isPartial,
      }),
      context,
    );
  },

  renderResult(result, _options, theme, context) {
    trace({ ev: "result", id: context.toolCallId, error: context.isError, text: resultText(result).slice(0, 120) });
    // The executed args stay in `finalArgs`: this row re-renders its call slot on every later
    // invalidate, and the streamed args it falls back to carry no `path` for `content`-first models.
    return writeResultComponent(context.isError ? resultText(result) || "write failed" : undefined, theme, context);
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    finalArgs.set(toolCallId, params);
    if (finalArgs.size > FINAL_ARGS_LIMIT) {
      const oldest = finalArgs.keys().next().value;
      if (oldest !== undefined) finalArgs.delete(oldest);
    }
    rememberWrite(params);
    trace({ ev: "exec", id: toolCallId, keys: Object.keys(params ?? {}), path: pathOf(params) ?? null });

    // Per call: the native implementation still resolves the path, serializes on its mutation queue
    // and honours the abort signal — only the byte-level write is ours, and it reports back what the
    // model-facing line needs (the pre-write size). A shared instance could not carry per-call state.
    let outcome: WriteOutcome = { oldBytes: null, bomKept: false };
    const inner = createWriteToolDefinition(ctx?.cwd ?? process.cwd(), {
      operations: {
        mkdir: async (dir) => {
          await mkdir(dir, { recursive: true });
        },
        writeFile: async (absolutePath, content) => {
          outcome = await writeTextPreservingBom(absolutePath, content);
        },
      },
    });
    const result = await inner.execute(toolCallId, params, signal, onUpdate, ctx);
    trace({ ev: "done", id: toolCallId, oldBytes: outcome.oldBytes, bomKept: outcome.bomKept });
    return {
      ...result,
      content: [{ type: "text", text: formatWriteResult(params.path, params.content, outcome.oldBytes) }],
    };
  },
};

export default function (pi: ExtensionAPI) {
  pi.registerTool(definition);
}
