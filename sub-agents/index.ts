import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatAgentList, loadBuiltinAgents } from "./agents.js";
import * as logger from "./logger.js";
import { getResultOutput, isFailedResult, runSingleAgent, type SubagentDetails, type SubagentMode, type SingleResult } from "./runner.js";
import { runSubAgentsTUI } from "./tui.js";

const MAX_MESSAGE_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 1500;

function makeDetails(mode: SubagentMode) {
  return (results: SingleResult[]): SubagentDetails => ({ mode, results });
}

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
    return { text, weight: 1 };
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
  const agent = agents.find((a) => a.name === "handoff-gemma");

  if (!agent) {
    const msg = `handoff-gemma agent not found. Available:\n${formatAgentList(agents)}`;
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

  await logger.info("Handoff start", { historyChars: history.length, taskChars: task.length }, cwd);
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
