import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatAgentList, loadBuiltinAgents } from "./agents.js";
import { formatHistoryForHandoff } from "./history.js";
import * as logger from "./logger.js";
import { getResultOutput, isFailedResult, runSingleAgent, type SubagentDetails, type SubagentMode, type SingleResult } from "./runner.js";
import { runSubAgentsTUI } from "./tui.js";

function makeDetails(mode: SubagentMode) {
  return (results: SingleResult[]): SubagentDetails => ({ mode, results });
}

function formatCompactDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
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

async function runHandoff(title: string | undefined, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const cwd = ctx.cwd;
  const agents = await loadBuiltinAgents();
  const agent = agents.find((a) => a.name === "handoff-instr");

  if (!agent) {
    const msg = `handoff-instr agent not found. Available:\n${formatAgentList(agents)}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const sessionManager = (ctx as any).sessionManager;
  if (!sessionManager || typeof sessionManager.getEntries !== "function") {
    const msg = "Session history is not available in this Pi version. /handoff requires a sessionManager.getEntries API.";
    await logger.error("Handoff unavailable", { reason: "missing sessionManager.getEntries" }, cwd);
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(msg);
    return;
  }

  const entries = sessionManager.getEntries() || [];
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
  const date = formatCompactDate();
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

  logger.info("pi-sub-agents extension loaded", undefined, process.cwd()).catch(() => {});
}
