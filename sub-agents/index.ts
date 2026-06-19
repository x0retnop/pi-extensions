import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverAgents, formatAgentList, loadBuiltinAgents, type AgentConfig } from "./agents.js";
import * as logger from "./logger.js";
import {
  getResultOutput,
  isFailedResult,
  mapWithConcurrencyLimit,
  runSingleAgent,
  truncateParallelOutput,
  type SingleResult,
  type SubagentDetails,
  type SubagentMode,
} from "./runner.js";
import { runSubAgentsTUI } from "./tui.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["cwd", "extension"] as const, {
  description: 'Where to load agent definitions from. Default: "cwd" (look for .md files in cwd). Use "extension" to force built-in fallback agents shipped with the extension.',
  default: "cwd",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function buildAgents(cwd: string, scope: "cwd" | "extension"): Promise<AgentConfig[]> {
  if (scope === "extension") {
    return loadBuiltinAgents();
  }
  return discoverAgents(cwd);
}

function makeDetails(mode: SubagentMode) {
  return (results: SingleResult[]): SubagentDetails => ({ mode, results });
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 1500;

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c.type === "text") return c.text;
        if (c.type === "toolCall") return `[toolCall: ${c.name}]`;
        if (c.type === "thinking") return `[thinking]`;
        if (c.type === "image") return `[image]`;
        return `[${c.type}]`;
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n...[truncated]";
}

function formatHistoryForHandoff(entries: any[], maxChars = 60000): string {
  const headChars = Math.floor(maxChars * 0.25);
  const tailChars = maxChars - headChars;

  const formatEntry = (entry: any): { text: string; weight: number } | null => {
    let text = "";

    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      const role = msg.role;
      const body = truncateText(extractTextFromMessageContent(msg.content), MAX_MESSAGE_CHARS);
      text = `## ${role}\n${body}\n\n`;
    } else if (entry.type === "toolResult" || entry.type === "tool_result") {
      const name = entry.toolName || entry.name || "tool";
      const summary = Array.isArray(entry.content)
        ? entry.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
        : String(entry.content);
      const preview = truncateText(summary, MAX_TOOL_RESULT_CHARS);
      text = `## Tool: ${name}\n${preview}\n\n`;
    } else if (entry.type === "custom") {
      text = `## Custom: ${entry.customType || "unknown"}\n${truncateText(JSON.stringify(entry.data), MAX_TOOL_RESULT_CHARS)}\n\n`;
    } else if (entry.type === "custom_message") {
      const body = truncateText(extractTextFromMessageContent(entry.content), MAX_MESSAGE_CHARS);
      text = `## Custom Message (${entry.customType || "unknown"})\n${body}\n\n`;
    } else if (entry.type === "compaction") {
      text = `## Compaction\n${truncateText(entry.summary || "", MAX_TOOL_RESULT_CHARS)}\n\n`;
    } else if (entry.type === "branch_summary") {
      text = `## Branch Summary\n${truncateText(entry.summary || "", MAX_TOOL_RESULT_CHARS)}\n\n`;
    }

    if (!text) return null;
    return { text, weight: entry.type === "compaction" || entry.type === "branch_summary" ? 2 : 1 };
  };

  const formatted = entries.map(formatEntry).filter((x): x is { text: string; weight: number } => x !== null);

  const takePrefix = (limit: number): string[] => {
    const out: string[] = [];
    let chars = 0;
    for (const { text, weight } of formatted) {
      const cost = text.length * weight;
      if (chars + cost > limit) break;
      chars += cost;
      out.push(text);
    }
    return out;
  };

  const takeSuffix = (limit: number): string[] => {
    const out: string[] = [];
    let chars = 0;
    for (let i = formatted.length - 1; i >= 0; i--) {
      const { text, weight } = formatted[i];
      const cost = text.length * weight;
      if (chars + cost > limit) break;
      chars += cost;
      out.unshift(text);
    }
    return out;
  };

  const head = takePrefix(headChars);
  const tail = takeSuffix(tailChars);

  const headEnd = head.length;
  const tailStart = formatted.length - tail.length;
  const skipped = tailStart - headEnd;

  if (skipped <= 0) {
    return formatted.map((f) => f.text).join("");
  }

  return [
    ...head,
    `## [${skipped} intermediate entries omitted — full history available in session file]\n\n`,
    ...tail,
  ].join("");
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned ? `-${cleaned}` : "";
}

async function runHandoff(title: string | undefined, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const cwd = ctx.cwd;
  const agents = await discoverAgents(cwd);
  const agent = agents.find((a) => a.name === "handoff-gemma");

  if (!agent) {
    const msg = `handoff-gemma agent not found. Available:\n${formatAgentList(agents)}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const entries = (ctx as any).sessionManager?.getEntries?.() || [];
  const history = formatHistoryForHandoff(entries);

  const task = [
    "Create a structured handoff markdown document from the following session history.",
    "Focus on: current goals, open tasks, key decisions, relevant files/snippets, recent changes, open questions/risks, next steps, and how to continue.",
    "Return ONLY the markdown content of the handoff file. Do not add any commentary outside the markdown.",
    "",
    "<session_history>",
    history,
    "</session_history>",
  ].join("\n");

  await logger.marker("Handoff start", cwd);
  const result = await runSingleAgent(
    cwd,
    agents,
    "handoff-gemma",
    task,
    undefined,
    undefined,
    ctx.signal,
    undefined,
    makeDetails("single"),
  );

  if (isFailedResult(result)) {
    const msg = `Handoff failed: ${getResultOutput(result)}`;
    await logger.error("Handoff failed", { error: getResultOutput(result) }, cwd);
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const output = getResultOutput(result).trim();
  const date = new Date().toISOString().slice(0, 10);
  const suffix = title ? sanitizeFilename(title) : "";
  const fileName = `handoff-${date}${suffix}.md`;
  const filePath = path.join(cwd, fileName);

  try {
    fs.writeFileSync(filePath, output, "utf-8");
    const msg = `Handoff written to ${filePath}`;
    await logger.info("Handoff written", { filePath, chars: output.length }, cwd);
    if (ctx.hasUI) ctx.ui.notify(msg, "info");
    else console.log(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logger.error("Handoff write error", { filePath, error: message }, cwd);
    if (ctx.hasUI) ctx.ui.notify(`Failed to write handoff: ${message}`, "error");
    else console.error(message);
  }
}

export default function (pi: ExtensionAPI) {
  // Prevent the extension from registering tools/commands inside a subagent child process.
  if (process.env.PI_SUB_AGENTS_CHILD === "1") {
    return;
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Offload self-contained work to a cheaper/faster subagent with an isolated context window. " +
      "Use scout-gemma for read-only reconnaissance, finding call sites, summarizing code, and gathering context before edits. " +
      "Use flash-worker for edits, refactoring, multi-file changes, and moderate debugging. " +
      "The subagent runs in a separate pi process and returns a concise result; intermediate tool output stays isolated. " +
      "Provide exactly one of: single {agent, task}, parallel {tasks:[...]}, or chain {chain:[...]}.",
    promptGuidelines: [
      "Use subagent when a task is self-contained and produces verbose intermediate output you do not need in the main conversation.",
      "Do NOT use subagent for trivial single edits or for tasks needing tight user back-and-forth.",
      "scout-gemma: read-only recon. Example tasks: list all .ts files under src/, find all callers of function X, summarize the public API of a module.",
      "flash-worker: coding/refactoring. Example tasks: add validation to function Y, refactor file Z to use async/await, implement a small multi-file change.",
      "Single mode: { agent: 'scout-gemma', task: '...', cwd?: '...' }.",
      "Parallel mode: { tasks: [{ agent: 'scout-gemma', task: '...' }, { agent: 'scout-gemma', task: '...' }] }.",
      "Chain mode: { chain: [{ agent: 'scout-gemma', task: 'gather context' }, { agent: 'flash-worker', task: 'implement based on: {previous}' }] }.",
      "The {previous} placeholder is replaced with the previous chain step's final output. In the next step's task, explicitly tell the agent to treat {previous} as authoritative context and not to re-read sources already covered by it.",
      "Every subagent starts with zero context. Include file paths, decisions, and expected output format in the task.",
      "Keep the main agent in control: delegate work, but synthesize results and verify key decisions yourself.",
      "If you need a handoff file, use the /handoff slash command instead of the subagent tool.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const scope = params.agentScope ?? "cwd";
      const agents = await buildAgents(ctx.cwd, scope);
      const makeDetailsFn = makeDetails("single");

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      await logger.info("subagent invoked", { modeCount, hasChain, hasTasks, hasSingle, scope }, ctx.cwd);

      if (modeCount !== 1) {
        const available = formatAgentList(agents);
        return {
          content: [
            { type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents:\n${available}` },
          ],
          details: makeDetailsFn([]),
        };
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const current = partial.details?.results[0];
                if (current) {
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")([...results, current]),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [
                { type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getResultOutput(result);
        }

        return {
          content: [{ type: "text", text: getResultOutput(results[results.length - 1]) || "(no output)" }],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [
              { type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
            ],
            details: makeDetails("parallel")([]),
          };
        }

        const allResults: SingleResult[] = new Array(params.tasks.length).fill(null).map((_, i) => ({
          agent: params.tasks![i].agent,
          agentSource: "unknown",
          task: params.tasks![i].task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        }));

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            t.agent,
            t.task,
            t.cwd,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel"),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const output = truncateParallelOutput(getResultOutput(r));
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${output}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );

        if (isFailedResult(result)) {
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: getResultOutput(result) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents:\n${formatAgentList(agents)}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme) {
      const scope = args.agentScope ?? "project";
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      const agentName = args.agent || "...";
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const lines: string[] = [];
      if (details.mode === "single") {
        const r = details.results[0];
        const icon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
        lines.push(`${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", getResultOutput(r).split("\n")[0] || "(no output)")}`);
      } else if (details.mode === "chain") {
        const ok = details.results.filter((r) => !isFailedResult(r)).length;
        lines.push(`${theme.fg("accent", "chain")} ${ok}/${details.results.length} steps`);
        for (const r of details.results) {
          const icon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
          lines.push(`  ${icon} ${theme.fg("accent", `[${r.step}] ${r.agent}`)}`);
        }
      } else if (details.mode === "parallel") {
        const ok = details.results.filter((r) => !isFailedResult(r)).length;
        lines.push(`${theme.fg("accent", "parallel")} ${ok}/${details.results.length} tasks`);
        for (const r of details.results) {
          const icon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
          lines.push(`  ${icon} ${theme.fg("accent", r.agent)}`);
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("handoff", {
    description:
      "Generate a structured, continuation-ready handoff file from the current session. " +
      "The file includes goals, open tasks, key decisions, relevant files/snippets, and a concrete first next step. " +
      "Usage: /handoff [short-title]",
    handler: async (args, ctx) => {
      const title = args.trim() || undefined;
      await runHandoff(title, ctx, pi);
    },
  });

  pi.registerCommand("sub-agents", {
    description:
      "Open the sub-agents TUI to run agents manually, view recent runs, and manage settings. " +
      "Usage: /sub-agents",
    handler: async (_args, ctx) => {
      await runSubAgentsTUI(ctx);
    },
  });

  logger.info("pi-sub-agents extension loaded", { cwd: process.cwd() }).catch(() => {});
}
