import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration } from "../common/duration.js";
import { setStatusBlock } from "../common/status.js";
import { formatAgentList, loadBuiltinAgents, visibleAgents } from "./agents.js";
import { formatHistoryForHandoff } from "./history.js";
import * as logger from "./logger.js";
import { getResultOutput, isFailedResult, runSingleAgent, type OnUpdateCallback, type SubagentDetails, type SubagentMode, type SingleResult } from "./runner.js";
import {
  applySubAgentsSection,
  containsSubAgentsMarker,
  loadParentSection,
  PARENT_SECTION_FILE,
  resolveSubAgentsEnabled,
} from "./parent-prompt.js";
import { getSettings, resolveAgents } from "./settings.js";

function makeSubagentDetails(
  mode: SubagentMode,
  agentName?: string,
  task?: string,
  resolved?: SubagentDetails["resolved"],
) {
  return (results: SingleResult[]): SubagentDetails => ({ mode, results, agentName, task, resolved });
}

function formatCompactDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function formatToolCallArgs(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const short = (s: string, max = 50) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  if (typeof args.path === "string" && ["read", "write", "edit", "multi_edit", "insert"].includes(name)) {
    return args.path;
  }
  if (typeof args.pattern === "string" && (name === "grep" || name === "find")) return short(args.pattern);
  if (name === "ls" && typeof args.path === "string") return args.path;
  if (name === "bash" && typeof args.command === "string") return short(args.command.trim());
  if (name === "pwsh" && typeof args.code === "string") return short(args.code.trim().split("\n")[0]);
  if (name === "py" && typeof args.code === "string") return short(args.code.trim().split("\n")[0]);
  if (name === "web_search") {
    if (typeof args.query === "string") return short(args.query);
    if (Array.isArray(args.queries)) return short(args.queries.join(" | "));
  }
  if (name === "fetch_content") {
    if (typeof args.url === "string") return short(args.url);
    if (Array.isArray(args.urls)) return short(args.urls.join(" | "));
  }
  // Unknown tool: the bare name reads better than a truncated JSON dump.
  return "";
}

/** Tool calls in order, with the tail kept: the last calls are what the run concluded with. */
function formatSubagentActions(result: SingleResult, limit: number): { shown: string[]; earlier: number } {
  const actions: string[] = [];
  for (const msg of result.messages) {
    if (msg.role !== "assistant") continue;
    const anyMsg = msg as any;
    for (const part of anyMsg.content ?? []) {
      if (part?.type === "toolCall" && typeof part.name === "string") {
        const arg = formatToolCallArgs(part.name, part.arguments);
        actions.push(arg ? `${part.name}(${arg})` : part.name);
      }
    }
  }
  if (actions.length <= limit) return { shown: actions, earlier: 0 };
  return { shown: actions.slice(actions.length - limit), earlier: actions.length - limit };
}

function firstTextContent(result: any): string | undefined {
  for (const part of result?.content ?? []) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text.trim();
  }
  return undefined;
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return cleaned ? `-${cleaned}` : "";
}

/** Pi's own "to expand" hint with the user's real binding; a literal fallback outside the TUI. */
function expandHint(): string {
  try {
    const bound = keyText("app.tools.expand").replace(/\x1b\[[0-9;]*m/g, "").trim();
    return bound ? keyHint("app.tools.expand", "to expand") : "Ctrl+O to expand";
  } catch {
    return "Ctrl+O to expand";
  }
}

function sanitizeTaskText(text: string): string {
  // Replace a full SGR reset with a softer reset so the TUI Box background
  // is not torn on wrapped lines.
  return text.replaceAll("\x1b[0m", "\x1b[22m\x1b[39m");
}

const BRIEF_PREVIEW_LINES = 5;

/** First `maxLines` non-empty brief lines, `#` stripped, plus how many were left out. */
function briefPreview(task: string, maxLines: number): { lines: { text: string; heading: boolean }[]; hidden: number } {
  const lines: { text: string; heading: boolean }[] = [];
  let hidden = 0;
  for (const raw of sanitizeTaskText(task).split(/\r?\n/)) {
    const stripped = raw.replace(/^#{1,6}\s+/, "").trim();
    if (!stripped) continue;
    if (lines.length < maxLines) lines.push({ text: stripped, heading: stripped !== raw.trim() });
    else hidden++;
  }
  return { lines, hidden };
}

const SUB_AGENTS_STATE_TYPE = "sub-agents-state";

interface SubAgentsState {
  enabled: boolean;
}

function getLatestSubAgentsState(ctx: any): SubAgentsState | null {
  const branch = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry?.customType === SUB_AGENTS_STATE_TYPE) {
      return entry.data as SubAgentsState;
    }
  }
  return null;
}

function syncSubAgentTools(pi: ExtensionAPI, enabled: boolean): void {
  const current = pi.getActiveTools();
  const base = current.filter((name) => name !== "spawn_agent");
  const next = enabled ? [...base, "spawn_agent"] : base;
  pi.setActiveTools([...new Set(next)]);
}

function setSubAgentsStatus(ctx: ExtensionCommandContext, enabled: boolean): void {
  setStatusBlock(ctx, "sub-agents", enabled ? "\x1b[38;5;114msub:on\x1b[0m" : undefined);
}

/** `handoff-instr` is includeExtensions:false + full prompt in the .md body.
 *  Role frontmatter is unused (role-sw is not loaded). Model is in the .md. */

async function runHandoff(title: string | undefined, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const cwd = ctx.cwd;
  const agents = resolveAgents(await loadBuiltinAgents(), getSettings());
  const agent = agents.find((a) => a.name === "handoff-instr");

  if (!agent) {
    const msg = `handoff-instr agent not found. Available:\n${formatAgentList(agents)}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const sessionManager = (ctx as any).sessionManager;
  const readBranch =
    typeof sessionManager?.getBranch === "function"
      ? () => sessionManager.getBranch()
      : typeof sessionManager?.getEntries === "function"
        ? () => sessionManager.getEntries()
        : null;
  if (!readBranch) {
    const msg = "Session history is not available in this Pi version. /handoff requires sessionManager.getBranch().";
    await logger.error("Handoff unavailable", { reason: "missing sessionManager.getBranch" }, cwd);
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const entries = readBranch() || [];
  const history = formatHistoryForHandoff({ entries, maxChars: 65_000 });

  const task = [
    "Create a structured handoff markdown document from the following session history.",
    "",
    "<session_history>",
    history,
    "</session_history>",
  ].join("\n");

  await logger.info("Handoff start", { historyChars: history.length, taskChars: task.length }, cwd);
  const result = await runSingleAgent(
    cwd,
    agents,
    "handoff-instr",
    task,
    undefined,
    undefined,
    ctx.signal,
    undefined,
    makeSubagentDetails("single"),
  );

  if (isFailedResult(result)) {
    const msg = `Handoff failed: ${getResultOutput(result)}`;
    await logger.error("Handoff failed", { error: getResultOutput(result) }, cwd);
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const output = getResultOutput(result).trim();
  const date = formatCompactDate();
  const suffix = title ? sanitizeFilename(title) : "";
  const fileName = `handoff-${date}${suffix}.md`;
  const filePath = path.join(cwd, fileName);

  const HANDOFF_HEADER = `> **Handoff snapshot — read-only, one-time context relay**
>
> Generated by \`/handoff\` in the \`sub-agents\` Pi extension from this session's history.
> Read it to pick up context, then continue the work in the actual project files.
> Do not edit, append, rewrite, or continue inside this file.
> This is a lossy summary: details may be missing or truncated; verify facts against real files.`;

  const finalOutput = `${HANDOFF_HEADER}\n\n${output}`;

  try {
    fs.writeFileSync(filePath, finalOutput, "utf-8");
    const msg = `Handoff written to ${filePath}`;
    await logger.info("Handoff written", { filePath, chars: finalOutput.length }, cwd);
    if (ctx.hasUI) ctx.ui.notify(msg, "info");
    else console.log(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logger.error("Handoff write error", { filePath, error: message }, cwd);
    if (ctx.hasUI) ctx.ui.notify(`Failed to write handoff: ${message}`, "error");
    else console.error(message);
  }
}

function handleSessionChange(pi: ExtensionAPI, ctx: any, reason?: string): void {
  const state = getLatestSubAgentsState(ctx);
  const { enabled, persistDefault } = resolveSubAgentsEnabled(state, reason);
  if (persistDefault) {
    pi.appendEntry(SUB_AGENTS_STATE_TYPE, { enabled: false });
  }
  syncSubAgentTools(pi, enabled);
  setSubAgentsStatus(ctx, enabled);
}

function toggleSubAgentsTool(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  nextEnabled: boolean,
): void {
  pi.appendEntry(SUB_AGENTS_STATE_TYPE, { enabled: nextEnabled });
  syncSubAgentTools(pi, nextEnabled);
  setSubAgentsStatus(ctx, nextEnabled);
}

export default async function (pi: ExtensionAPI) {
  // Prevent the extension from registering tools/commands inside a subagent child process.
  if (process.env.PI_SUB_AGENTS_CHILD === "1") {
    return;
  }

  const builtinAgents = await loadBuiltinAgents();

  // Agents exposed to the LLM-facing spawn_agent tool. Each maps to one built-in
  // agent file; model/role/tools are configured via frontmatter or TUI overrides.
  const SPAWN_AGENT_NAMES = ["explorer", "reviewer", "coder"];
  const spawnAgentBulletList = SPAWN_AGENT_NAMES
    .map((name) => {
      const agent = builtinAgents.find((a) => a.name === name);
      return agent ? `- \`${agent.name}\` — ${agent.description}` : `- \`${name}\` — not configured`;
    })
    .join("\n");
  const spawnAgentNameList = SPAWN_AGENT_NAMES.join(", ");

  pi.on("session_start", (event, ctx) => handleSessionChange(pi, ctx, event.reason));
  pi.on("session_tree", (_event, ctx) => handleSessionChange(pi, ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    if (!containsSubAgentsMarker(event.systemPrompt)) return;
    const enabled = getLatestSubAgentsState(ctx)?.enabled ?? true;
    const section = enabled ? await loadParentSection() : null;
    if (enabled && !section?.trim() && ctx.hasUI) {
      ctx.ui.notify(`sub-agents: ${PARENT_SECTION_FILE} not found in role-sw/roles/`, "warning");
    }
    const systemPrompt = applySubAgentsSection(event.systemPrompt, enabled, section);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });

  pi.registerCommand("sub", {
    description:
      "Toggle the spawn_agent sub-agent tool on/off. " +
      "Usage: /sub [on|off|toggle|status]. Default toggles.",
    handler: async (args, ctx) => {
      const state = getLatestSubAgentsState(ctx);
      const currentlyEnabled = state?.enabled ?? true;
      const arg = args.trim().toLowerCase();
      let enabled: boolean;
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else if (arg === "status") {
        ctx.ui.notify(`Sub-agent tool is ${currentlyEnabled ? "ON" : "OFF"}`, currentlyEnabled ? "info" : "warning");
        return;
      } else {
        enabled = !currentlyEnabled;
      }

      toggleSubAgentsTool(pi, ctx, enabled);
      ctx.ui.notify(`Sub-agent tool ${enabled ? "ON" : "OFF"}`, "info");
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
      const { runSubAgentsTUI } = await import("./tui.js");
      await runSubAgentsTUI(ctx, pi);
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "spawn_agent",

    description:
      "Spawn one isolated sub-agent (fresh context, no parent history) and get its final report. " +
      "Available agents:\n" +
      spawnAgentBulletList +
      "\n`explorer` and `reviewer` never touch project source; each writes only its own artifact (map/brief, review log) " +
      "into the cwd — verify the tree if it matters. " +
      "`coder` changes project source and leaves it uncommitted for you to review and commit. Read the artifact the " +
      "child names instead of re-deriving it. " +
      "On failure the error carries a transcript path — the failed run's full brief is in that file under `## Prompt (brief)`; " +
      "read it and re-spawn with the same `task` rather than re-briefing from scratch.",

    parameters: Type.Object({
      agent: Type.String({
        description: `Agent to spawn: ${spawnAgentNameList}.`,
      }),
      task: Type.String({
        description:
          "Self-contained brief: goal, the exact paths, what counts as done (a command or an observable result, not " +
          "\"it works\"), decisions already taken, and the user's own words verbatim. The child sees none of this " +
          "conversation and has no user to ask. Optional: the artifact file it should write in the cwd (e.g. " +
          "`Write full findings to map-auth.md`); otherwise it picks a short name.",
      }),
      cwd: Type.Optional(Type.String({
        description: "Working directory for the sub-agent. Defaults to the current project cwd.",
      })),
    }),

    renderCall(args: any, theme: Theme, context: any) {
      const agentName = args.agent || "...";
      const task = typeof args.task === "string" ? args.task : "";
      const cwd = typeof args.cwd === "string" && args.cwd ? theme.fg("dim", ` @ ${args.cwd}`) : "";
      const expanded = context?.expanded === true;
      const size = task ? ` · brief ${(Buffer.byteLength(task, "utf8") / 1024).toFixed(1)} KB` : "";
      const preview = briefPreview(task, expanded ? Number.MAX_SAFE_INTEGER : BRIEF_PREVIEW_LINES);
      const body = preview.lines.map((l) => (l.heading ? theme.bold(l.text) : theme.fg("dim", l.text)));
      if (body.length === 0) body.push(theme.fg("dim", "(no brief)"));
      if (preview.hidden > 0) {
        body.push(
          theme.fg("dim", `… (${preview.hidden} more lines, `) +
            expandHint() +
            theme.fg("dim", ")"),
        );
      }
      // Two children: the header at column 0 and the brief indented by Text's own
      // padding, so wrapped continuation lines stay aligned.
      const container = new Container();
      container.addChild(
        new Text(
          `${theme.fg("toolTitle", theme.bold("spawn_agent"))} ${theme.fg("accent", agentName)}${cwd}${theme.fg("dim", size)}`,
          0,
          0,
        ),
      );
      container.addChild(new Text(body.join("\n"), 2, 0));
      return container;
    },

    renderResult(result: any, { expanded, isPartial }: any, theme: Theme, context: any) {
      const details = result.details as SubagentDetails | undefined;
      const r = details?.results?.[0];
      const progress = details?.progress;
      // `isError` is not on the result Pi hands the renderer — it lives on the
      // render context; a rejected call (bad agent name, unconfigured agent)
      // carries empty `details`, so without it the block would read `done`.
      const failed = context?.isError === true || (r ? isFailedResult(r) : false);
      const status = isPartial
        ? theme.fg("warning", `running… ${formatDuration(progress?.elapsedMs ?? 0)}${progress ? ` · ${progress.turns} turns` : ""}`)
        : r?.interrupted
          ? theme.fg("warning", "stopped by guard")
          : failed
            ? theme.fg("error", "failed")
            : theme.fg("success", "done");
      const meta: string[] = [];
      if (r) {
        // While running, progress already reports turns next to the elapsed time.
        if (!isPartial) meta.push(`${r.usage.turns} turns`);
        meta.push(`$${r.usage.cost.toFixed(4)}`);
        if (r.durationMs !== undefined) meta.push(formatDuration(r.durationMs));
      }
      if (progress?.contextPercent !== undefined) meta.push(`ctx ${progress.contextPercent.toFixed(0)}%`);
      const lines = [`${status}${meta.length ? theme.fg("dim", ` · ${meta.join(" · ")}`) : ""}`];
      if (!isPartial && r?.interrupted) {
        lines.push(theme.fg("warning", `guard: ${r.interrupted.reason}`));
      }
      if (!isPartial && failed && !r?.interrupted) {
        const text = (firstTextContent(result) ?? r?.errorMessage ?? "sub-agent failed").replace(/^Subagent failed:\s*/i, "");
        lines.push(theme.fg("error", `error: ${text.split("\n")[0]}`));
      }
      const actions = r
        ? formatSubagentActions(r, expanded ? Number.MAX_SAFE_INTEGER : 5)
        : { shown: [], earlier: 0 };
      if (actions.shown.length > 0) {
        lines.push(theme.fg("toolTitle", actions.earlier > 0 ? `actions (last ${actions.shown.length} of ${actions.shown.length + actions.earlier}):` : "actions:"));
        for (const a of actions.shown) lines.push(`  ${theme.fg("dim", a)}`);
      }
      if (r?.transcriptPath && !isPartial) {
        lines.push(theme.fg("dim", `transcript: ${r.transcriptPath}`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const agents = resolveAgents(builtinAgents, getSettings());

      if (!SPAWN_AGENT_NAMES.includes(params.agent)) {
        return {
          content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available agents: ${spawnAgentNameList}.` }],
          details: {},
          isError: true,
        };
      }

      const requestedAgent = agents.find((a) => a.name === params.agent);
      if (!requestedAgent) {
        return {
          content: [{ type: "text", text: `Agent "${params.agent}" is not configured. Check the sub-agents extension files and settings.json overrides.` }],
          details: {},
          isError: true,
        };
      }

      const resolved = {
        model: requestedAgent.model,
        role: requestedAgent.role,
        tools: requestedAgent.tools,
        filePath: requestedAgent.filePath,
      };
      const metadata = { agentName: requestedAgent.name, task: params.task, resolved };
      const wrappedOnUpdate: OnUpdateCallback | undefined = onUpdate
        ? (partial) => {
            const base = partial.details ?? { mode: "single", results: [] };
            partial.details = { ...base, ...metadata };
            onUpdate(partial as any);
          }
        : undefined;

      const result = await runSingleAgent(
        cwd,
        agents,
        params.agent,
        params.task,
        params.cwd,
        undefined,
        signal,
        wrappedOnUpdate,
        makeSubagentDetails("single", requestedAgent.name, params.task, resolved),
      );

      const details: SubagentDetails = { mode: "single", results: [result], ...metadata };

      if (isFailedResult(result)) {
        return {
          content: [{ type: "text", text: `Subagent failed: ${getResultOutput(result)}` }],
          details,
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: getResultOutput(result) }],
        details,
      };
    },
  });

  logger.info("pi-sub-agents extension loaded", undefined, process.cwd()).catch(() => {});
}
