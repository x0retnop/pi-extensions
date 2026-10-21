import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { formatDuration, parseDuration } from "../common/duration.js";
import { setStatusBlock } from "../common/status.js";
import { loadBuiltinAgents, visibleAgents, type AgentConfig } from "./agents.js";
import * as logger from "./logger.js";
import {
  buildPiArgsPreview,
  getResultOutput,
  isFailedResult,
  runSingleAgent,
  GUARD_DEFAULTS,
  type SingleResult,
  type SubagentMode,
} from "./runner.js";
import {
  formatEffective,
  getSettings,
  listAvailableRoles,
  listFavoriteModels,
  resolveAgent,
  saveSettings,
  TOOL_PRESETS,
  type AgentOverrides,
  type SubAgentsSettings,
} from "./settings.js";

const SUB_AGENTS_STATE_TYPE = "sub-agents-state";

interface SubAgentsState {
  enabled: boolean;
}

function getLatestSubAgentsState(ctx: ExtensionCommandContext): SubAgentsState | null {
  const branch = (ctx as any).sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry?.customType === SUB_AGENTS_STATE_TYPE) {
      return entry.data as SubAgentsState;
    }
  }
  return null;
}

const HISTORY_DIR = path.join(os.homedir(), ".pi", "agent", "sub-agents-history");

interface HistoryEntry {
  timestamp: string;
  agent: string;
  mode: SubagentMode;
  task: string;
  cwd: string;
  cliCommand: string;
  /** Effective config snapshot at run time. */
  resolved?: { model?: string; role?: string; tools?: string[] };
  result: {
    exitCode: number;
    outputPreview: string;
    stderrPreview: string;
    stopReason?: string;
    transcriptPath?: string;
  };
  steps?: Array<{ agent: string; task: string }>;
  // Legacy fields from the extension-policy era; kept for old entries.
  extensionsPolicy?: string;
  customExtensions?: string[];
}

function ensureHistoryDir(): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function listHistoryFiles(): string[] {
  ensureHistoryDir();
  try {
    return fs
      .readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Fallback for history entries written before transcriptPath was recorded. */
function findLatestTranscript(agentName: string): string | undefined {
  ensureHistoryDir();
  try {
    const safeAgent = agentName.replace(/[^\w.-]+/g, "_");
    const match = fs
      .readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(`-${safeAgent}.transcript.md`))
      .sort()
      .reverse()[0];
    return match ? path.join(HISTORY_DIR, match) : undefined;
  } catch {
    return undefined;
  }
}

function readHistoryFile(fileName: string): HistoryEntry | undefined {
  try {
    const raw = fs.readFileSync(path.join(HISTORY_DIR, fileName), "utf-8");
    return JSON.parse(raw) as HistoryEntry;
  } catch {
    return undefined;
  }
}

function writeHistoryFile(entry: HistoryEntry): void {
  ensureHistoryDir();
  const safeAgent = entry.agent.replace(/[^\w.-]+/g, "_");
  const fileName = `${entry.timestamp.replace(/[:T]/g, "-")}-${safeAgent}.json`;
  try {
    fs.writeFileSync(path.join(HISTORY_DIR, fileName), JSON.stringify(entry, null, 2), "utf-8");
  } catch {
    // ignore
  }
}

function deleteHistoryFile(fileName: string): void {
  try {
    fs.unlinkSync(path.join(HISTORY_DIR, fileName));
  } catch {
    // ignore
  }
}

function clearOldHistory(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  ensureHistoryDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json") || f.endsWith(".transcript.md"));
  } catch {
    return 0;
  }
  for (const file of files) {
    const full = path.join(HISTORY_DIR, file);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

async function editString(ctx: ExtensionCommandContext, title: string, current: string): Promise<string | undefined> {
  const result = await ctx.ui.editor(title, current);
  if (result === undefined) return undefined;
  return result.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

async function pickOne(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
  return ctx.ui.select(title, options);
}

async function configureRun(
  ctx: ExtensionCommandContext,
  agent: AgentConfig,
  initialCwd: string,
): Promise<{ cwd: string } | undefined> {
  let cwd = initialCwd;

  while (true) {
    const options = [
      `Model: ${agent.model ?? "(default)"}  ·  Role: ${agent.role ?? "(none)"}  ·  Tools: ${agent.tools?.join(",") || "(default)"}`,
      `Working directory: ${cwd || "(current project)"}`,
      "Run",
      "Cancel",
    ];
    const choice = await pickOne(ctx, `Run ${agent.name} (edit model/role/tools in Settings)`, options);
    if (!choice || choice === "Cancel") return undefined;
    if (choice === "Run") return { cwd };

    if (choice.startsWith("Working directory:")) {
      const value = await editString(ctx, "Working directory (empty = current project)", cwd);
      if (value === undefined) continue;
      cwd = value.trim();
    }
    // The model/role/tools row is display-only; persistent edits live in Settings.
  }
}

function runGitCommand(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = child_process.spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status ?? 1,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

function isGitRepo(cwd: string): boolean {
  return runGitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]).exitCode === 0;
}

function getGitDiff(cwd: string, source: string): string {
  switch (source) {
    case "last-commit":
      return runGitCommand(cwd, ["diff", "HEAD~1..HEAD"]).stdout;
    case "staged":
      return runGitCommand(cwd, ["diff", "--cached"]).stdout;
    default:
      return "";
  }
}

async function pickFile(ctx: ExtensionCommandContext, cwd: string, title: string): Promise<string | undefined> {
  const result = await ctx.ui.input(title, "path relative to project root");
  if (result === undefined) return undefined;
  const fullPath = path.join(cwd, result);
  if (!fs.existsSync(fullPath)) {
    ctx.ui.notify(`File not found: ${result}`, "error");
    return undefined;
  }
  return fullPath;
}

async function runReviewInteractive(ctx: ExtensionCommandContext): Promise<void> {
  const agents = await loadBuiltinAgents();
  const agent = agents.find((a) => a.name === "reviewer");
  if (!agent) {
    ctx.ui.notify("reviewer agent not found.", "error");
    return;
  }

  const hasGit = isGitRepo(ctx.cwd);
  const sourceOptions = hasGit
    ? ["Last commit", "Staged", "Current file", "Custom text/diff"]
    : ["Current file", "Custom text/diff"];

  const source = await pickOne(ctx, "Review source", sourceOptions);
  if (!source) return;

  let content = "";
  let sourceLabel = source;

  if (source === "Last commit") {
    content = getGitDiff(ctx.cwd, "last-commit");
    sourceLabel = "last commit";
  } else if (source === "Staged") {
    content = getGitDiff(ctx.cwd, "staged");
    sourceLabel = "staged changes";
  } else if (source === "Current file") {
    const filePath = await pickFile(ctx, ctx.cwd, "File to review");
    if (!filePath) return;
    try {
      content = fs.readFileSync(filePath, "utf-8");
      sourceLabel = path.relative(ctx.cwd, filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to read file: ${message}`, "error");
      return;
    }
  } else if (source === "Custom text/diff") {
    const custom = await editString(ctx, "Paste diff or text to review", "");
    if (custom === undefined || custom.trim() === "") return;
    content = custom;
    sourceLabel = "custom input";
  }

  if (content.trim() === "") {
    ctx.ui.notify("Nothing to review.", "error");
    return;
  }

  const focus = await editString(ctx, "Optional review focus (or leave empty)", "");
  if (focus === undefined) return;

  const task = [
    "Review the following code and return a prioritized list of issues.",
    `Source: ${sourceLabel}`,
    focus.trim() ? `Focus areas: ${focus.trim()}` : "",
    "",
    "```",
    content,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  await runSingleTask(ctx, agent, task, "review");
}

async function runAgentInteractive(ctx: ExtensionCommandContext): Promise<void> {
  const agents = visibleAgents(await loadBuiltinAgents());
  if (agents.length === 0) {
    ctx.ui.notify("No agents found.", "error");
    return;
  }

  const settings = getSettings();
  const agentLabels = agents.map((a) => `${a.name} · ${formatEffective(resolveAgent(a, settings))}`);
  const selectedLabel = await pickOne(ctx, "Select agent (model · role · tools)", agentLabels);
  if (!selectedLabel) return;

  const selectedAgentName = selectedLabel.split(" · ")[0];
  const agent = agents.find((a) => a.name === selectedAgentName)!;

  const task = await editString(ctx, `Task for ${selectedAgentName}`, "");
  if (task === undefined || task.trim() === "") return;

  await runSingleTask(ctx, agent, task);
}

async function runSingleTask(
  ctx: ExtensionCommandContext,
  agent: AgentConfig,
  task: string,
  taskName?: string,
): Promise<void> {
  const settings = getSettings();
  const resolved = resolveAgent(agent, settings);
  const defaultCwd = settings.defaultCwd ?? ctx.cwd;

  const run = await configureRun(ctx, resolved, defaultCwd);
  if (!run) return;

  const effectiveCwd = run.cwd || ctx.cwd;
  const cliPreview = `${buildPiArgsPreview(resolved)} <<'TASK'\n${task}\nTASK`;

  await logger.info(
    "TUI run task",
    { agent: agent.name, task: taskName || "(custom)", cwd: effectiveCwd, resolved: { model: resolved.model, role: resolved.role, tools: resolved.tools } },
    ctx.cwd,
  );

  const result = await runSingleAgent(
    effectiveCwd,
    [resolved],
    agent.name,
    task,
    undefined,
    undefined,
    ctx.signal,
    undefined,
    (results) => ({ mode: "single", results }),
  );

  const failed = isFailedResult(result);
  const output = getResultOutput(result);

  const historyEntry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    agent: agent.name,
    mode: "single",
    task,
    cwd: effectiveCwd,
    cliCommand: cliPreview,
    resolved: { model: resolved.model, role: resolved.role, tools: resolved.tools },
    steps: [{ agent: agent.name, task }],
    result: {
      exitCode: failed ? 1 : 0,
      outputPreview: output.slice(0, 2000),
      stderrPreview: result.stderr.slice(0, 1000),
      stopReason: result.stopReason,
      transcriptPath: result.transcriptPath,
    },
  };
  writeHistoryFile(historyEntry);

  if (failed) {
    if (result.interrupted) {
      ctx.ui.notify(`Stopped by guard: ${result.interrupted.reason} (partial output kept)`, "warning");
    } else {
      ctx.ui.notify(`Agent failed: ${result.errorMessage || result.stopReason || "unknown error"}`, "error");
    }
  } else {
    ctx.ui.notify("Run completed", "info");
  }

  await showResultMenu(ctx, agent.name, taskName, output);
}

function formatCompactDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return cleaned ? `-${cleaned}` : "";
}

async function showResultMenu(
  ctx: ExtensionCommandContext,
  agentName: string,
  taskName: string | undefined,
  output: string,
): Promise<void> {
  while (true) {
    const choice = await pickOne(ctx, "Result", ["View", "Copy to clipboard", "Save to file", "Send to chat", "Close"]);
    if (!choice || choice === "Close") return;

    if (choice === "View") {
      await ctx.ui.editor("Result", output);
    } else if (choice === "Copy to clipboard") {
      await copyToClipboard(output);
      ctx.ui.notify("Copied to clipboard", "info");
    } else if (choice === "Save to file") {
      const date = formatCompactDate();
      const suffix = taskName ? sanitizeFilename(taskName) : sanitizeFilename(agentName);
      const fileName = `report-${date}${suffix}.md`;
      const filePath = path.join(ctx.cwd, fileName);
      try {
        fs.writeFileSync(filePath, output, "utf-8");
        ctx.ui.notify(`Saved to ${filePath}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to save: ${message}`, "error");
      }
    } else if (choice === "Send to chat") {
      const label = taskName ? `${agentName} (${taskName})` : agentName;
      const message = `Result from ${label}:\n\n${output}`;
      await copyToClipboard(message);
      ctx.ui.notify("Message copied to clipboard — paste into chat.", "info");
    }
  }
}

async function showRecentRuns(ctx: ExtensionCommandContext): Promise<void> {
  const files = listHistoryFiles();
  if (files.length === 0) {
    ctx.ui.notify("No recent runs.", "info");
    return;
  }

  const labels = files.map((f) => {
    const entry = readHistoryFile(f);
    const status = entry ? (entry.result.exitCode === 0 ? "✓" : "✗") : "?";
    return `${status} ${f}`;
  });

  const choice = await pickOne(ctx, "Recent runs", [...labels, "Clear old history", "Back"]);
  if (!choice || choice === "Back") return;

  if (choice === "Clear old history") {
    const settings = getSettings();
    const days = settings.historyRetentionDays ?? 30;
    const removed = clearOldHistory(days);
    ctx.ui.notify(`Removed ${removed} old entries`, "info");
    return;
  }

  const fileName = choice.replace(/^.. /, "");
  const entry = readHistoryFile(fileName);
  if (!entry) {
    ctx.ui.notify("Failed to read history entry.", "error");
    return;
  }

  const detail = [
    `Agent: ${entry.agent}`,
    `Mode: ${entry.mode}`,
    `Cwd: ${entry.cwd}`,
    entry.resolved
      ? `Resolved: model=${entry.resolved.model ?? "default"}, role=${entry.resolved.role ?? "none"}, tools=${entry.resolved.tools?.join(",") || "default"}`
      : entry.extensionsPolicy
        ? `Extensions (legacy): ${entry.extensionsPolicy}${entry.customExtensions ? ` (${entry.customExtensions.join(", ")})` : ""}`
        : null,
    `Exit code: ${entry.result.exitCode}`,
    entry.result.transcriptPath ? `Transcript: ${entry.result.transcriptPath}` : null,
    "",
    "CLI:",
    entry.cliCommand,
    "",
    "Output:",
    entry.result.outputPreview,
  ].filter((l) => l !== null).join("\n");

  const action = await pickOne(ctx, "History action", ["View full", "Open transcript", "Rerun", "Delete", "Back"]);
  if (action === "View full") {
    await ctx.ui.editor(fileName, detail);
  } else if (action === "Open transcript") {
    const transcriptPath = entry.result.transcriptPath ?? findLatestTranscript(entry.agent);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      ctx.ui.notify("No transcript found for this run.", "warning");
      return;
    }
    const content = fs.readFileSync(transcriptPath, "utf-8");
    await ctx.ui.editor(path.basename(transcriptPath), content);
  } else if (action === "Rerun") {
    if (entry.mode === "parallel" || entry.mode === "chain" || (entry.steps && entry.steps.length > 1)) {
      ctx.ui.notify("Legacy parallel/chain runs cannot be rerun. Start a new single run from the menu.", "warning");
      return;
    }
    const raw = entry.steps?.[0] ?? (entry.task ? { agent: entry.agent, task: entry.task } : undefined);
    if (!raw?.task) {
      ctx.ui.notify("Cannot rerun this history entry: no task recorded.", "error");
      return;
    }
    const agents = await loadBuiltinAgents();
    const agent = agents.find((a) => a.name === raw.agent);
    if (!agent) {
      ctx.ui.notify(`Agent not found: ${raw.agent}`, "error");
      return;
    }
    await runSingleTask(ctx, agent, raw.task);
  } else if (action === "Delete") {
    deleteHistoryFile(fileName);
    ctx.ui.notify("Deleted", "info");
  }
}

async function editAgentOverride(
  ctx: ExtensionCommandContext,
  settings: SubAgentsSettings,
  agent: AgentConfig,
): Promise<void> {
  const ov: AgentOverrides = { ...(settings.agentOverrides?.[agent.name] ?? {}) };

  const save = () => {
    const cleaned: AgentOverrides = {};
    if (ov.model) cleaned.model = ov.model;
    if (ov.role !== undefined) cleaned.role = ov.role;
    if (ov.tools) cleaned.tools = ov.tools;
    if (ov.timeoutMs) cleaned.timeoutMs = ov.timeoutMs;
    if (ov.maxTurns) cleaned.maxTurns = ov.maxTurns;
    if (ov.deadlineMs) cleaned.deadlineMs = ov.deadlineMs;
    if (ov.idleMs) cleaned.idleMs = ov.idleMs;
    if (ov.toolIdleMs) cleaned.toolIdleMs = ov.toolIdleMs;
    if (ov.contextLimitPercent) cleaned.contextLimitPercent = ov.contextLimitPercent;
    if (ov.maxExtensions !== undefined) cleaned.maxExtensions = ov.maxExtensions;
    if (ov.extendGraceMs) cleaned.extendGraceMs = ov.extendGraceMs;
    const next = { ...(settings.agentOverrides ?? {}) };
    if (Object.keys(cleaned).length === 0) delete next[agent.name];
    else next[agent.name] = cleaned;
    settings.agentOverrides = next;
  };

  /** Show the code default when neither the override nor the frontmatter sets a value. */
  const inheritHint = (override: number | undefined, fromFile: number | undefined, fallback: number | null): string => {
    if (override !== undefined) return String(override);
    if (fromFile !== undefined) return `(frontmatter: ${fromFile})`;
    return fallback === null ? "(default: off)" : `(default: ${fallback})`;
  };

  /** ms knobs: the value the user thinks in first, the stored number after it. */
  const msValue = (v: number): string => `${formatDuration(v)} (${v} ms)`;
  const inheritMsHint = (override: number | undefined, fromFile: number | undefined, fallback: number | null): string => {
    if (override !== undefined) return msValue(override);
    if (fromFile !== undefined) return `(frontmatter: ${msValue(fromFile)})`;
    return fallback === null ? "(default: off)" : `(default: ${msValue(fallback)})`;
  };
  /** Prompt for a ms knob; the parser accepts `10m` / `1h30m` / plain ms. */
  const ASK_MS = "ms, or 10m / 1h30m (empty = inherit)";

  while (true) {
    const effective = resolveAgent(agent, settings);
    const options = [
      `Model: ${ov.model ?? `(frontmatter: ${agent.model ?? "default"})`}`,
      `Role: ${ov.role ?? `(frontmatter: ${agent.role ?? settings.defaultRole ?? "none"})`}`,
      `Tools: ${ov.tools ? ov.tools.join(",") : `(frontmatter: ${agent.tools?.join(",") || "default"})`}`,
      `Hard limit: ${inheritMsHint(ov.timeoutMs, agent.timeoutMs, GUARD_DEFAULTS.hardMs)}`,
      `Max turns: ${inheritHint(ov.maxTurns, agent.maxTurns, GUARD_DEFAULTS.maxTurns)}`,
      `Deadline: ${inheritMsHint(ov.deadlineMs, agent.deadlineMs, GUARD_DEFAULTS.deadlineMs)}`,
      `Idle: ${inheritMsHint(ov.idleMs, agent.idleMs, GUARD_DEFAULTS.idleMs)}`,
      `Tool idle: ${inheritMsHint(ov.toolIdleMs, agent.toolIdleMs, GUARD_DEFAULTS.toolIdleMs)}`,
      `Context limit: ${ov.contextLimitPercent ?? `(default: ${GUARD_DEFAULTS.contextLimitPercent})`} %`,
      `Cap extensions: ${inheritHint(ov.maxExtensions, agent.maxExtensions, GUARD_DEFAULTS.maxExtensions)} (×50% each, recent-turn grace)`,
      `Extend grace: ${inheritMsHint(ov.extendGraceMs, agent.extendGraceMs, GUARD_DEFAULTS.extendGraceMs)}`,
      `Effective: ${formatEffective(effective)}`,
      "Reset all overrides",
      "Back",
    ];

    const choice = await pickOne(ctx, `Overrides: ${agent.name}`, options);
    if (!choice || choice === "Back") {
      save();
      return;
    }

    if (choice.startsWith("Model:")) {
      const models = listFavoriteModels();
      const labels = ["(inherit)", ...models.map((m) => m.label)];
      const picked = await pickOne(ctx, "Model (pinned /mm favorites)", labels);
      if (picked === undefined) continue;
      if (picked === "(inherit)") {
        ov.model = undefined;
      } else {
        ov.model = models.find((m) => m.label === picked)?.id ?? picked;
      }
    } else if (choice.startsWith("Role:")) {
      const roles = await listAvailableRoles();
      const picked = await pickOne(ctx, "Role (none = default Pi prompt)", ["(inherit)", "(none)", ...roles]);
      if (picked === undefined) continue;
      ov.role = picked === "(inherit)" ? undefined : picked === "(none)" ? "none" : picked;
    } else if (choice.startsWith("Tools:")) {
      const presetNames = Object.keys(TOOL_PRESETS);
      const picked = await pickOne(ctx, "Tools preset", ["(inherit)", ...presetNames, "custom"]);
      if (picked === undefined) continue;
      if (picked === "(inherit)") {
        ov.tools = undefined;
      } else if (picked === "custom") {
        const current = ov.tools ?? agent.tools ?? [];
        const selected = await editString(ctx, "Tools (comma-separated)", current.join(","));
        if (selected === undefined) continue;
        ov.tools = selected.split(",").map((t) => t.trim()).filter(Boolean);
      } else {
        ov.tools = TOOL_PRESETS[picked];
      }
    } else if (choice.startsWith("Hard limit:")) {
      const value = await editString(ctx, `Hard wall-clock ceiling, ${ASK_MS}`, String(ov.timeoutMs ?? ""));
      if (value === undefined) continue;
      ov.timeoutMs = parseDuration(value);
    } else if (choice.startsWith("Max turns:")) {
      const value = await editString(ctx, "Max turns (empty = inherit)", String(ov.maxTurns ?? ""));
      if (value === undefined) continue;
      ov.maxTurns = Number(value) > 0 ? Number(value) : undefined;
    } else if (choice.startsWith("Deadline:")) {
      const value = await editString(ctx, `Soft deadline, ${ASK_MS}`, String(ov.deadlineMs ?? ""));
      if (value === undefined) continue;
      ov.deadlineMs = parseDuration(value);
    } else if (choice.startsWith("Idle:")) {
      const value = await editString(ctx, `Idle, ${ASK_MS} — no output, no tool running`, String(ov.idleMs ?? ""));
      if (value === undefined) continue;
      ov.idleMs = parseDuration(value);
    } else if (choice.startsWith("Tool idle:")) {
      const value = await editString(ctx, `Tool idle, ${ASK_MS} — no output while a tool runs`, String(ov.toolIdleMs ?? ""));
      if (value === undefined) continue;
      ov.toolIdleMs = parseDuration(value);
    } else if (choice.startsWith("Context limit:")) {
      const value = await editString(ctx, "Stop at this share of the child's context window, % (0 = off, empty = inherit)", String(ov.contextLimitPercent ?? ""));
      if (value === undefined) continue;
      const n = Number(value);
      ov.contextLimitPercent = Number.isFinite(n) && n >= 0 ? n : undefined;
    } else if (choice.startsWith("Cap extensions:")) {
      const value = await editString(ctx, "Cap extensions, count (0 = never extend, empty = inherit)", String(ov.maxExtensions ?? ""));
      if (value === undefined) continue;
      const n = Number(value);
      ov.maxExtensions = Number.isInteger(n) && n >= 0 ? n : undefined;
    } else if (choice.startsWith("Extend grace:")) {
      const value = await editString(ctx, `Extend grace, ${ASK_MS} — a cap extends only if a turn completed within this window`, String(ov.extendGraceMs ?? ""));
      if (value === undefined) continue;
      ov.extendGraceMs = parseDuration(value);
    } else if (choice === "Reset all overrides") {
      const next = { ...(settings.agentOverrides ?? {}) };
      delete next[agent.name];
      settings.agentOverrides = next;
      return;
    }
    save();
  }
}

async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
  const settings = getSettings();
  const agents = visibleAgents(await loadBuiltinAgents());

  while (true) {
    const agentLabels = agents.map((a) => {
      const hasOverride = settings.agentOverrides?.[a.name] ? "*" : " ";
      return `${hasOverride} ${a.name}: ${formatEffective(resolveAgent(a, settings))}`;
    });

    const options = [
      `Default cwd: ${settings.defaultCwd || "(current project)"}`,
      `Default role: ${settings.defaultRole || "(none)"}`,
      `History retention: ${settings.historyRetentionDays ?? 30} days`,
      `Debug log: ${settings.debugLog ? "on" : "off"}`,
      "─ Agent overrides (* = overridden) ─",
      ...agentLabels,
      "Save and exit",
      "Discard",
    ];

    const choice = await pickOne(ctx, "Settings", options);
    if (!choice || choice === "Discard") return;
    if (choice === "Save and exit") {
      await saveSettings(settings);
      ctx.ui.notify("Settings saved", "info");
      return;
    }

    if (choice.startsWith("Default cwd:")) {
      const value = await editString(ctx, "Default cwd (empty = current project)", settings.defaultCwd ?? "");
      if (value === undefined) continue;
      settings.defaultCwd = value.trim() || undefined;
    } else if (choice.startsWith("Default role:")) {
      const roles = await listAvailableRoles();
      const picked = await pickOne(ctx, "Default role for agents without one", ["(none)", ...roles]);
      if (picked === undefined) continue;
      settings.defaultRole = picked === "(none)" ? undefined : picked;
    } else if (choice.startsWith("History retention:")) {
      const value = await editString(ctx, "History retention days (0 = keep forever)", String(settings.historyRetentionDays ?? 30));
      if (value === undefined) continue;
      settings.historyRetentionDays = Math.max(0, Number(value) || 0);
    } else if (choice.startsWith("Debug log:")) {
      settings.debugLog = !settings.debugLog;
    } else if (choice.startsWith("─") || choice === "Save and exit") {
      continue;
    } else {
      const agentName = agents.map((a) => a.name).find((name) => choice.includes(`${name}:`));
      if (agentName) {
        const agent = agents.find((a) => a.name === agentName)!;
        await editAgentOverride(ctx, settings, agent);
      }
    }
  }
}

function syncSubAgentTools(pi: ExtensionAPI, enabled: boolean): void {
  const current = pi.getActiveTools();
  const base = current.filter((name) => name !== "spawn_agent");
  const next = enabled ? [...base, "spawn_agent"] : base;
  pi.setActiveTools([...new Set(next)]);
}

function setSubAgentsStatus(ctx: ExtensionCommandContext, enabled: boolean): void {
  setStatusBlock(ctx, "sub-agents", enabled ? "sub:on" : undefined);
}

export async function runSubAgentsTUI(ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/sub-agents requires interactive TUI mode.", "error");
    return;
  }

  if (!pi) {
    ctx.ui.notify("Tool toggle is not available in this context.", "error");
    return;
  }

  while (true) {
    const state = getLatestSubAgentsState(ctx);
    const toolEnabled = state?.enabled ?? true;
    const choice = await pickOne(ctx, "Sub-agents", [
      `Sub-agent tool: ${toolEnabled ? "● ON" : "○ OFF"}`,
      "Run agent",
      "Review / reviewer",
      "Recent runs",
      "Settings",
      "Help",
      "Exit",
    ]);
    if (!choice || choice === "Exit") return;

    if (choice.startsWith("Sub-agent tool:")) {
      const nextEnabled = !toolEnabled;
      pi.appendEntry(SUB_AGENTS_STATE_TYPE, { enabled: nextEnabled });
      syncSubAgentTools(pi, nextEnabled);
      setSubAgentsStatus(ctx, nextEnabled);
      ctx.ui.notify(`Sub-agent tool ${nextEnabled ? "ON" : "OFF"}`, "info");
      continue;
    }

    try {
      if (choice === "Run agent") {
        await runAgentInteractive(ctx);
      } else if (choice === "Review / reviewer") {
        await runReviewInteractive(ctx);
      } else if (choice === "Recent runs") {
        await showRecentRuns(ctx);
      } else if (choice === "Settings") {
        await showSettings(ctx);
      } else if (choice === "Help") {
        const help = [
          "Sub-agents TUI help:",
          "",
          "Run agent — pick an agent (labels show effective model · role · tools) and write a task.",
          "Review / reviewer — review last commit, staged changes, a file, or custom diff/text.",
          "Recent runs — view, open transcript, rerun or delete previous runs.",
          "Settings — default cwd/role, retention, debug log, per-agent overrides.",
          "",
          "Per-agent overrides (model = /mm favorites, role, tools, timeout, maxTurns) win over frontmatter.",
          "Role = full custom system prompt composed by role-sw inside the child;",
          "agents without a role get the default Pi prompt + agent body.",
          "",
          "Settings live in ~/.pi/agent/settings.json under the \"subAgents\" key.",
          "History + transcripts: ~/.pi/agent/sub-agents-history/.",
        ].join("\n");
        await ctx.ui.editor("Help", help);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logger.error("TUI error", { error: message }, ctx.cwd);
      ctx.ui.notify(`TUI error: ${message}`, "error");
    }
  }
}
