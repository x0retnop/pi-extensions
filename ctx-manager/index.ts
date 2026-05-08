import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * ctx-manager.ts
 *
 * Manual context helper for Pi Agent CLI.
 *
 * Commands:
 *   /ctx
 *   /ctx clear
 *   /ctx-status
 *   /ctx-status on
 *   /ctx-status off
 *   /ctx-compact [extra instructions]
 *   /ctx-handoff [goal]
 *   /ctx-handoff-lite [goal]
 *
 * Design:
 *   - No automatic compaction.
 *   - No footer replacement.
 *   - /ctx-handoff asks the current model to write the handoff in the normal chat.
 *   - /ctx-handoff-lite builds a cheap draft locally and shows it in a separate editor window.
 */

const EXT_ID = "ctx-manager";
const STATUS_ID = "ctx-manager-status";
const WIDGET_ID = "ctx-manager-widget";

const CONFIG = {
  statusEnabledByDefault: true,

  // Only used for status labels. Does not trigger automatic compaction.
  warnAtPercent: 65,
  compactAtPercent: 80,

  // /ctx-handoff-lite local extraction limits.
  maxLiteUserMessages: 8,
  maxLiteAssistantMessages: 5,
  maxLiteFiles: 40,
  maxMessageChars: 900,
  maxAssistantChars: 700,

  widgetPlacement: "belowEditor" as const,
};

/**
 * Default manual compaction instruction.
 * Replace this later with your own stronger version.
 */
const DEFAULT_COMPACT_INSTRUCTIONS = `
Keep only information needed to continue the current coding task.
Preserve: current goal, user preferences, files discussed or modified, important decisions,
commands that worked, unresolved errors, and next steps.
Remove: repeated discussion, dead ends, verbose logs, and obsolete alternatives.
`.trim();

/**
 * Prompt used by /ctx-handoff.
 * This is sent into the current chat as a user message, so the model writes
 * the handoff prompt in the normal conversation history.
 */
const SMART_HANDOFF_PROMPT = `
Write a compact handoff prompt for starting a new session.

Use the current conversation context. Do not use tools. Do not modify files.
Return only the prompt text for the new session.

Include:
- current goal
- important user preferences and constraints
- relevant files and paths
- decisions already made
- commands/checks that worked or failed
- current unresolved issues
- exact next steps

Keep it concise, practical, and self-contained.
`.trim();

type EntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
};

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
};

type ContextStats = {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  branchEntries: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  compactEntries: number;
  modelName: string;
  cwd: string;
};

let statusEnabled = CONFIG.statusEnabledByDefault;
let activeTaskStartedAtMs: number | undefined;
let lastTaskDurationMs: number | undefined;

export default function ctxManager(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    resetSessionState();
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    startTaskTimer();
    updateStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const durationMs = finishTaskTimer();

    if (durationMs !== undefined) {
      showTaskDuration(ctx, durationMs);
    }

    updateStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  (pi.on as any)("thinking_level_select", async (_event: any, ctx: ExtensionContext) => {
    updateStatus(ctx);
  });

  pi.registerCommand("ctx", {
    description: "Show current context usage and session stats",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "clear" || arg === "hide") {
        clearWidget(ctx);
        ctx.ui.notify("ctx widget cleared", "info");
        updateStatus(ctx);
        return;
      }

      const lines = buildCtxWidgetLines(ctx);
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_ID, lines, { placement: CONFIG.widgetPlacement });
      } else {
        console.log(lines.join("\n"));
      }

      updateStatus(ctx, true);
    },
  });

  pi.registerCommand("ctx-status", {
    description: "Toggle persistent context status in the footer status area",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "off" || arg === "disable" || arg === "0") {
        statusEnabled = false;
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.notify("ctx status disabled", "info");
        return;
      }

      if (arg === "on" || arg === "enable" || arg === "1") {
        statusEnabled = true;
        updateStatus(ctx, true);
        ctx.ui.notify("ctx status enabled", "info");
        return;
      }

      statusEnabled = !statusEnabled;

      if (statusEnabled) {
        updateStatus(ctx, true);
        ctx.ui.notify("ctx status enabled", "info");
      } else {
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.notify("ctx status disabled", "info");
      }
    },
  });

  pi.registerCommand("ctx-compact", {
    description: "Manually trigger Pi compaction with default or custom instructions",
    handler: async (args, ctx) => {
      const extra = args.trim();
      const customInstructions = extra
        ? `${DEFAULT_COMPACT_INSTRUCTIONS}\n\nExtra user instructions:\n${extra}`
        : DEFAULT_COMPACT_INSTRUCTIONS;

      ctx.ui.notify("ctx compaction started", "info");

      ctx.compact({
        customInstructions,
        onComplete: () => {
          ctx.ui.notify("ctx compaction completed", "info");
          updateStatus(ctx, true);
        },
        onError: (error) => {
          ctx.ui.notify(`ctx compaction failed: ${error.message}`, "error");
          updateStatus(ctx, true);
        },
      });
    },
  });

  pi.registerCommand("ctx-handoff", {
    description: "Ask the current model to write a handoff prompt in the normal chat",
    handler: async (args, ctx) => {
      const goal = args.trim() || "Continue the current work from the cleanest useful point.";
      const stats = getContextStats(ctx);

      const prompt = [
        SMART_HANDOFF_PROMPT,
        "",
        "User goal for the new session:",
        goal,
        "",
        "Current context stats:",
        formatStatsOneLine(stats),
      ].join("\n");

      await ctx.waitForIdle();

      ctx.ui.notify("asking model to write handoff prompt in chat", "info");

      // This intentionally writes into the normal chat and triggers the model.
      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("ctx-handoff-lite", {
    description: "Build a cheap local handoff draft in a separate editor window",
    handler: async (args, ctx) => {
      const goal = args.trim() || "Continue the current work from the cleanest useful point.";
      const draft = buildLiteHandoffDraft(ctx, goal);

      if (!ctx.hasUI) {
        console.log(draft);
        return;
      }

      const edited = await ctx.ui.editor("ctx-handoff-lite: copy/edit draft", draft);

      if (edited === undefined) {
        ctx.ui.notify("ctx-handoff-lite closed", "info");
        return;
      }

      // Do not send it to chat automatically. This keeps terminal/session history clean.
      ctx.ui.notify("ctx-handoff-lite draft closed; copy it manually if needed", "info");
    },
  });
}

function resetSessionState(): void {
  statusEnabled = CONFIG.statusEnabledByDefault;
  activeTaskStartedAtMs = undefined;
  lastTaskDurationMs = undefined;
}

function startTaskTimer(): void {
  activeTaskStartedAtMs = Date.now();
}

function finishTaskTimer(): number | undefined {
  if (activeTaskStartedAtMs === undefined) return undefined;

  const durationMs = Math.max(0, Date.now() - activeTaskStartedAtMs);
  activeTaskStartedAtMs = undefined;
  lastTaskDurationMs = durationMs;

  return durationMs;
}

function showTaskDuration(ctx: ExtensionContext, durationMs: number): void {
  const message = `task time: ${formatDuration(durationMs)}`;

  try {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "info");
    } else {
      console.log(message);
    }
  } catch {
    // Timing display must never interfere with the agent run.
  }
}

function formatTaskTimingForStatus(): string {
  if (activeTaskStartedAtMs !== undefined) {
    return ` · task ${formatDuration(Date.now() - activeTaskStartedAtMs)}`;
  }

  if (lastTaskDurationMs !== undefined) {
    return ` · last ${formatDuration(lastTaskDurationMs)}`;
  }

  return "";
}

function formatTaskTimingForWidget(): string {
  if (activeTaskStartedAtMs !== undefined) {
    return `running ${formatDuration(Date.now() - activeTaskStartedAtMs)}`;
  }

  if (lastTaskDurationMs !== undefined) {
    return `last ${formatDuration(lastTaskDurationMs)}`;
  }

  return "n/a";
}

function updateStatus(ctx: ExtensionContext, force = false): void {
  if (!statusEnabled && !force) return;

  const status = buildStatusLine(ctx);
  ctx.ui.setStatus(STATUS_ID, status);
}

function clearWidget(ctx: ExtensionCommandContext): void {
  ctx.ui.setWidget(WIDGET_ID, undefined);
}

function buildStatusLine(ctx: ExtensionContext): string {
  const stats = getContextStats(ctx);
  const taskTiming = formatTaskTimingForStatus();

  if (stats.tokens === undefined) {
    return `ctx: n/a · branch ${stats.branchEntries}${taskTiming}`;
  }

  if (stats.contextWindow === undefined || stats.percent === undefined) {
    return `ctx: ${formatTokens(stats.tokens)} · branch ${stats.branchEntries}${taskTiming}`;
  }

  const level =
    stats.percent >= CONFIG.compactAtPercent
      ? "compact?"
      : stats.percent >= CONFIG.warnAtPercent
        ? "watch"
        : "ok";

  return `ctx: ${formatTokens(stats.tokens)}/${formatTokens(stats.contextWindow)} · ${stats.percent}% · ${level}${taskTiming}`;
}

function buildCtxWidgetLines(ctx: ExtensionCommandContext): string[] {
  const stats = getContextStats(ctx);

  return [
    "ctx-manager",
    "",
    `usage: ${formatUsage(stats)}`,
    `model: ${stats.modelName}`,
    `cwd: ${stats.cwd}`,
    `branch entries: ${stats.branchEntries}`,
    `messages: ${stats.messages} · user ${stats.userMessages} · assistant ${stats.assistantMessages}`,
    `compact-like entries: ${stats.compactEntries}`,
    `task timing: ${formatTaskTimingForWidget()}`,
    "",
    "commands:",
    "  /ctx clear",
    "  /ctx-status on|off",
    "  /ctx-compact [extra instructions]",
    "  /ctx-handoff [goal]",
    "  /ctx-handoff-lite [goal]",
  ];
}

function getContextStats(ctx: ExtensionContext): ContextStats {
  const branch = getBranch(ctx);
  const usage = safeGetContextUsage(ctx);
  const contextWindow = getContextWindow(ctx);

  let messages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let compactEntries = 0;

  for (const entry of branch) {
    if (entry.type === "message") {
      messages++;
      if (entry.message?.role === "user") userMessages++;
      if (entry.message?.role === "assistant") assistantMessages++;
    }

    const typeText = `${entry.type ?? ""} ${entry.customType ?? ""}`.toLowerCase();
    if (typeText.includes("compact") || typeText.includes("summary")) {
      compactEntries++;
    }
  }

  const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
  const percent =
    tokens !== undefined && contextWindow !== undefined && contextWindow > 0
      ? Math.round((tokens / contextWindow) * 100)
      : undefined;

  return {
    tokens,
    contextWindow,
    percent,
    branchEntries: branch.length,
    messages,
    userMessages,
    assistantMessages,
    compactEntries,
    modelName: getModelName(ctx),
    cwd: ctx.cwd,
  };
}

function safeGetContextUsage(ctx: ExtensionContext): { tokens?: number | null } | undefined {
  try {
    return ctx.getContextUsage() ?? undefined;
  } catch {
    return undefined;
  }
}

function getContextWindow(ctx: ExtensionContext): number | undefined {
  const model = ctx.model as unknown as Record<string, unknown> | undefined;
  const value = model?.contextWindow ?? model?.context_window;

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getModelName(ctx: ExtensionContext): string {
  const model = ctx.model as unknown as Record<string, unknown> | undefined;
  const name = model?.name ?? model?.id;

  return typeof name === "string" && name.trim() ? name : "no-model";
}

function getBranch(ctx: ExtensionContext): EntryLike[] {
  try {
    const branch = ctx.sessionManager.getBranch();
    return Array.isArray(branch) ? (branch as EntryLike[]) : [];
  } catch {
    return [];
  }
}

function buildLiteHandoffDraft(ctx: ExtensionCommandContext, goal: string): string {
  const branch = getBranch(ctx);
  const stats = getContextStats(ctx);
  const messages = getMessageEntries(branch);

  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .filter(Boolean)
    .slice(-CONFIG.maxLiteUserMessages)
    .map((text) => `- ${truncateOneLine(text, CONFIG.maxMessageChars)}`);

  const assistantTexts = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.text)
    .filter(Boolean)
    .slice(-CONFIG.maxLiteAssistantMessages)
    .map((text) => `- ${truncateOneLine(text, CONFIG.maxAssistantChars)}`);

  const allText = messages.map((m) => m.text).join("\n");
  const files = collectFilePaths(allText).slice(0, CONFIG.maxLiteFiles);

  return [
    "# Start prompt for new Pi Agent session",
    "",
    "## Goal",
    goal,
    "",
    "## Current project",
    `cwd: ${ctx.cwd}`,
    "",
    "## Context status",
    formatStatsOneLine(stats),
    "",
    "## Relevant files mentioned",
    files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "- No obvious file paths found by local heuristic.",
    "",
    "## Recent user requests",
    userTexts.length > 0 ? userTexts.join("\n") : "- No recent user text found.",
    "",
    "## Recent assistant notes",
    assistantTexts.length > 0 ? assistantTexts.join("\n") : "- No recent assistant text found.",
    "",
    "## Instructions for the new session",
    "- First inspect relevant files before editing.",
    "- Preserve the user's existing coding preferences and constraints.",
    "- Avoid pulling unrelated project context unless needed.",
    "- Keep changes minimal and verify with cheap checks first.",
    "",
    "---",
    "Note: this draft was generated locally by ctx-handoff-lite without a model call.",
  ].join("\n");
}

function getMessageEntries(branch: EntryLike[]): Array<{ role: string; text: string }> {
  const result: Array<{ role: string; text: string }> = [];

  for (const entry of branch) {
    if (entry.type !== "message") continue;

    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(entry.message?.content).trim();
    if (!text) continue;

    result.push({ role, text });
  }

  return result;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const parts: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;

    const block = item as ContentBlock;

    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }

    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`Tool call: ${block.name}`);
    }
  }

  return parts.join("\n");
}

function collectFilePaths(text: string): string[] {
  const fileRe =
    /(?:[A-Za-z]:[\\/])?(?:[^\s"'`<>|:]+[\\/])*[A-Za-z0-9_.@()[\]-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|md|markdown|yaml|yml|toml|ini|env|css|scss|html|xml|rs|go|java|kt|cs|cpp|c|h|hpp|sql|sh|ps1|bat|cmd)/g;

  const seen = new Set<string>();
  const matches = text.match(fileRe) ?? [];

  for (const raw of matches) {
    const cleaned = raw.trim().replace(/[),.;]+$/g, "");
    if (cleaned.length > 0) seen.add(cleaned);
  }

  return Array.from(seen).sort();
}

function formatUsage(stats: ContextStats): string {
  if (stats.tokens === undefined) return "n/a";

  if (stats.contextWindow === undefined || stats.percent === undefined) {
    return `${formatTokens(stats.tokens)}`;
  }

  return `${formatTokens(stats.tokens)} / ${formatTokens(stats.contextWindow)} · ${stats.percent}%`;
}

function formatStatsOneLine(stats: ContextStats): string {
  return [
    `usage=${formatUsage(stats)}`,
    `model=${stats.modelName}`,
    `branch=${stats.branchEntries}`,
    `messages=${stats.messages}`,
    `compactEntries=${stats.compactEntries}`,
  ].join(" · ");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(value);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars - 1)}…`;
}
