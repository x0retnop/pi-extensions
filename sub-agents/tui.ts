import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { discoverAgents, loadBuiltinAgents, loadBuiltinTasks, type AgentConfig, type TaskConfig } from "./agents.js";
import * as logger from "./logger.js";
import { getResultOutput, isFailedResult, mapWithConcurrencyLimit, runSingleAgent, type SingleResult, type SubagentMode } from "./runner.js";

const SETTINGS_KEY = "subAgents";
const HISTORY_DIR = path.join(os.homedir(), ".pi", "agent", "sub-agents-history");
const EXTENSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");

export interface AgentExtensionSettings {
  policy?: "inherit" | "none" | "custom";
  extensions?: string[];
}

export interface SubAgentsSettings {
  defaultCwd?: string;
  defaultExtensionsPolicy?: "inherit" | "none" | "custom";
  defaultCustomExtensions?: string[];
  agentExtensions?: Record<string, AgentExtensionSettings>;
  historyRetentionDays?: number;
  lastAgent?: string;
  lastMode?: SubagentMode;
}

interface HistoryEntry {
  timestamp: string;
  agent: string;
  mode: SubagentMode;
  task: string;
  cwd: string;
  extensionsPolicy: string;
  customExtensions?: string[];
  cliCommand: string;
  result: {
    exitCode: number;
    outputPreview: string;
    stderrPreview: string;
    stopReason?: string;
  };
  steps?: Array<{ agent: string; task: string }>;
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
  for (const file of listHistoryFiles()) {
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

function getSettings(): SubAgentsSettings {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed[SETTINGS_KEY] as SubAgentsSettings) ?? {};
  } catch {
    return {};
  }
}

async function saveSettings(settings: SubAgentsSettings): Promise<void> {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let parsed: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    parsed = JSON.parse(raw);
  } catch {
    // start fresh
  }
  parsed[SETTINGS_KEY] = settings;
  fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2), "utf-8");
}

function listInstalledExtensions(): string[] {
  try {
    return fs
      .readdirSync(EXTENSIONS_DIR)
      .filter((f) => {
        const full = path.join(EXTENSIONS_DIR, f);
        try {
          return fs.statSync(full).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function getAgentExtensionDefaults(
  settings: SubAgentsSettings,
  agentName: string,
): { policy: "inherit" | "none" | "custom"; extensions: string[] } {
  const perAgent = settings.agentExtensions?.[agentName];
  const policy = perAgent?.policy ?? settings.defaultExtensionsPolicy ?? "inherit";
  const extensions = perAgent?.extensions ?? settings.defaultCustomExtensions ?? [];
  return { policy, extensions };
}

function formatPolicyLabel(policy: string, extensions: string[]): string {
  if (policy === "custom" && extensions.length > 0) return `custom (${extensions.join(", ")})`;
  if (policy === "custom") return "custom (none selected)";
  return policy;
}

async function editString(ctx: ExtensionCommandContext, title: string, current: string): Promise<string | undefined> {
  const result = await ctx.ui.editor(title, current);
  if (result === undefined) return undefined;
  return result.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

async function pickOne(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
  return ctx.ui.select(title, options);
}

async function pickMany(
  ctx: ExtensionCommandContext,
  title: string,
  options: string[],
  initiallySelected: string[],
): Promise<string[] | undefined> {
  const selected = new Set(initiallySelected);
  while (true) {
    const items = options.map((opt) => {
      const mark = selected.has(opt) ? "[x]" : "[ ]";
      return `${mark} ${opt}`;
    });
    const choice = await ctx.ui.select(`${title} (toggle, then Done)`, [...items, "Done"]);
    if (choice === undefined) return undefined;
    if (choice === "Done") return Array.from(selected);
    const opt = choice.replace(/^\[[x ]\] /, "");
    if (selected.has(opt)) selected.delete(opt);
    else selected.add(opt);
  }
}

function formatCliPreview(
  agent: AgentConfig,
  mode: SubagentMode,
  task: string,
  cwd: string,
  extensionsPolicy: string,
  customExtensions: string[],
): string {
  const args: string[] = ["pi", "--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  if (extensionsPolicy === "custom" && customExtensions.length > 0) {
    args.push("--no-extensions");
    for (const ext of customExtensions) {
      args.push("--extension", path.join(EXTENSIONS_DIR, ext));
    }
  } else if (extensionsPolicy === "none") {
    args.push("--no-extensions");
  }

  return `${args.join(" ")} <<'TASK'\n${task}\nTASK`;
}

function buildAgentForRun(agent: AgentConfig, extensionsPolicy: string, customExtensions: string[]): AgentConfig {
  if (extensionsPolicy === "custom") {
    return { ...agent, includeExtensions: false, extensions: customExtensions.map((e) => path.join(EXTENSIONS_DIR, e)) };
  }
  if (extensionsPolicy === "none") {
    return { ...agent, includeExtensions: false };
  }
  return { ...agent, includeExtensions: true };
}

interface Step {
  agent: AgentConfig;
  task: string;
}

async function collectSteps(
  ctx: ExtensionCommandContext,
  mode: SubagentMode,
  agents: AgentConfig[],
  agentNames: string[],
): Promise<Step[] | undefined> {
  const steps: Step[] = [];
  if (mode === "single") {
    const task = await editString(ctx, "Task (one or more lines)", "");
    if (task === undefined) return undefined;
    return [{ agent: agents[0], task }];
  }

  while (true) {
    const title = mode === "parallel" ? "Parallel tasks" : "Chain steps";
    const choice = await pickOne(ctx, `${title} (${steps.length} added)`, ["Add step", "Done", "Cancel"]);
    if (!choice || choice === "Cancel") return undefined;
    if (choice === "Done") {
      if (steps.length === 0) {
        ctx.ui.notify("Add at least one step.", "error");
        continue;
      }
      return steps;
    }

    const stepAgentName = await pickOne(ctx, "Agent for this step", agentNames);
    if (!stepAgentName) continue;
    const stepAgent = agents.find((a) => a.name === stepAgentName)!;
    const task = await editString(ctx, `Task for ${stepAgentName}`, "");
    if (task === undefined) continue;
    steps.push({ agent: stepAgent, task });
  }
}

async function configureRunOverrides(
  ctx: ExtensionCommandContext,
  settings: SubAgentsSettings,
  agents: AgentConfig[],
  initialPolicy: "inherit" | "none" | "custom",
  initialExtensions: string[],
  initialCwd: string,
): Promise<{ policy: "inherit" | "none" | "custom"; extensions: string[]; cwd: string } | undefined> {
  let policy = initialPolicy;
  let extensions = [...initialExtensions];
  let cwd = initialCwd;

  while (true) {
    const options = [
      `Extensions: ${formatPolicyLabel(policy, extensions)}`,
      `Working directory: ${cwd || "(current project)"}`,
      "Save and run",
      "Cancel",
    ];
    const choice = await pickOne(ctx, "Override run settings", options);
    if (!choice || choice === "Cancel") return undefined;
    if (choice === "Save and run") return { policy, extensions, cwd };

    if (choice.startsWith("Extensions:")) {
      const policies = ["inherit", "none", "custom"];
      const policyLabels = ["inherit (all active extensions)", "none (isolated)", "custom (select extensions)"];
      const selected = await pickOne(ctx, "Extensions policy", policyLabels);
      if (!selected) continue;
      policy = policies[policyLabels.indexOf(selected)] as "inherit" | "none" | "custom";
      if (policy === "custom") {
        const installed = listInstalledExtensions();
        const picked = await pickMany(ctx, "Select extensions", installed, extensions);
        if (picked === undefined) continue;
        extensions = picked;
      } else {
        extensions = [];
      }
    } else if (choice.startsWith("Working directory:")) {
      const value = await editString(ctx, "Working directory (empty = current project)", cwd);
      if (value === undefined) continue;
      cwd = value.trim();
    }
  }
}

async function executeSteps(
  ctx: ExtensionCommandContext,
  steps: Step[],
  mode: SubagentMode,
  effectiveCwd: string,
  extensionsPolicy: string,
  customExtensions: string[],
  parallelConcurrency: number = 3,
): Promise<{ results: SingleResult[]; finalOutput: string; summary: string; failedResults: SingleResult[] }> {
  let results: SingleResult[];
  if (mode === "single") {
    const step = steps[0];
    const runAgent = buildAgentForRun(step.agent, extensionsPolicy, customExtensions);
    const result = await runSingleAgent(
      effectiveCwd,
      [runAgent],
      step.agent.name,
      step.task,
      undefined,
      undefined,
      ctx.signal,
      undefined,
      (results) => ({ mode: "single", results }),
    );
    results = [result];
  } else if (mode === "parallel") {
    results = await mapWithConcurrencyLimit(
      steps,
      Math.min(parallelConcurrency, steps.length),
      async (step, index) => {
        const runAgent = buildAgentForRun(step.agent, extensionsPolicy, customExtensions);
        return runSingleAgent(
          effectiveCwd,
          [runAgent],
          step.agent.name,
          step.task,
          undefined,
          index + 1,
          ctx.signal,
          undefined,
          (results) => ({ mode: "parallel", results }),
        );
      },
    );
  } else {
    results = [];
    let previousOutput = "";
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const task = step.task.replace(/\{previous\}/g, previousOutput);
      const runAgent = buildAgentForRun(step.agent, extensionsPolicy, customExtensions);
      const result = await runSingleAgent(
        effectiveCwd,
        [runAgent],
        step.agent.name,
        task,
        undefined,
        i + 1,
        ctx.signal,
        undefined,
        (results) => ({ mode: "chain", results }),
      );
      results.push(result);
      previousOutput = getResultOutput(result);
    }
  }

  const failedResults = results.filter((r) => isFailedResult(r));
  const summary = results
    .map((r, i) => {
      const output = getResultOutput(r);
      return `Step ${i + 1} (${r.agent}): exitCode=${r.exitCode}${isFailedResult(r) ? " FAILED" : ""}\n${output.slice(0, 1000)}`;
    })
    .join("\n\n---\n\n");
  const finalOutput = mode === "chain" ? getResultOutput(results[results.length - 1]) : summary;

  return { results, finalOutput, summary, failedResults };
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

async function runCriticInteractive(ctx: ExtensionCommandContext): Promise<void> {
  const agents = await discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    const builtin = await loadBuiltinAgents();
    if (builtin.length > 0) agents.push(...builtin);
  }
  const agent = agents.find((a) => a.name === "critic");
  if (!agent) {
    ctx.ui.notify("critic agent not found.", "error");
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
  const agents = await discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    const builtin = await loadBuiltinAgents();
    if (builtin.length > 0) agents.push(...builtin);
  }
  if (agents.length === 0) {
    ctx.ui.notify("No agents found.", "error");
    return;
  }

  const agentNames = agents.map((a) => a.name);
  const selectedAgentName = await pickOne(ctx, "Select agent", agentNames);
  if (!selectedAgentName) return;

  const agent = agents.find((a) => a.name === selectedAgentName)!;

  const task = await editString(ctx, `Task for ${selectedAgentName}`, "");
  if (task === undefined || task.trim() === "") return;

  await runSingleTask(ctx, agent, task);
}

async function runTaskInteractive(ctx: ExtensionCommandContext): Promise<void> {
  const tasks = await loadBuiltinTasks();
  if (tasks.length === 0) {
    ctx.ui.notify("No task files found in extension tasks/ folder.", "error");
    return;
  }

  const taskLabels = tasks.map((t) => `${t.name}: ${t.description}`);
  const selectedLabel = await pickOne(ctx, "Select task", taskLabels);
  if (!selectedLabel) return;

  const taskConfig = tasks.find((t) => selectedLabel.startsWith(`${t.name}:`))!;

  let prompt = taskConfig.prompt;
  if (prompt.includes("{input}")) {
    const input = await editString(ctx, `Input for "${taskConfig.name}"`, "");
    if (input === undefined) return;
    prompt = prompt.replace(/\{input\}/g, input);
  }

  const agents = await discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    const builtin = await loadBuiltinAgents();
    if (builtin.length > 0) agents.push(...builtin);
  }
  const agent = agents.find((a) => a.name === taskConfig.agent);
  if (!agent) {
    ctx.ui.notify(`Agent "${taskConfig.agent}" not found for task "${taskConfig.name}".`, "error");
    return;
  }

  await runSingleTask(ctx, agent, prompt, taskConfig.name);
}

async function runSingleTask(
  ctx: ExtensionCommandContext,
  agent: AgentConfig,
  task: string,
  taskName?: string,
): Promise<void> {
  const settings = getSettings();
  const defaults = getAgentExtensionDefaults(settings, agent.name);
  const defaultCwd = settings.defaultCwd ?? ctx.cwd;

  const overrides = await configureRunOverrides(ctx, settings, [agent], defaults.policy, defaults.extensions, defaultCwd);
  if (!overrides) return;

  const effectiveCwd = overrides.cwd || ctx.cwd;

  const cliPreview = formatCliPreview(agent, "single", task, effectiveCwd, overrides.policy, overrides.extensions);

  await logger.info(
    "TUI run task",
    { agent: agent.name, task: taskName || "(custom)", cwd: effectiveCwd, extensionsPolicy: overrides.policy },
    ctx.cwd,
  );

  const runAgent = buildAgentForRun(agent, overrides.policy, overrides.extensions);
  const result = await runSingleAgent(
    effectiveCwd,
    [runAgent],
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
    extensionsPolicy: overrides.policy,
    customExtensions: overrides.policy === "custom" ? overrides.extensions : undefined,
    cliCommand: cliPreview,
    steps: [{ agent: agent.name, task }],
    result: {
      exitCode: failed ? 1 : 0,
      outputPreview: output.slice(0, 2000),
      stderrPreview: result.stderr.slice(0, 1000),
      stopReason: result.stopReason,
    },
  };
  writeHistoryFile(historyEntry);

  settings.lastAgent = agent.name;
  settings.lastMode = "single";
  await saveSettings(settings);

  if (failed) {
    ctx.ui.notify(`Agent failed: ${result.errorMessage || result.stopReason || "unknown error"}`, "error");
  } else {
    ctx.ui.notify("Run completed", "info");
  }

  await showResultMenu(ctx, agent.name, taskName, output);
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
    `Extensions: ${entry.extensionsPolicy}${entry.customExtensions ? ` (${entry.customExtensions.join(", ")})` : ""}`,
    `Exit code: ${entry.result.exitCode}`,
    "",
    "CLI:",
    entry.cliCommand,
    "",
    "Output:",
    entry.result.outputPreview,
  ].join("\n");

  const action = await pickOne(ctx, "History action", ["View full", "Rerun", "Delete", "Back"]);
  if (action === "View full") {
    await ctx.ui.editor(fileName, detail);
  } else if (action === "Rerun") {
    const agents = await discoverAgents(entry.cwd);

    let rawSteps: Array<{ agent: string; task: string }> = [];
    if (entry.steps && entry.steps.length > 0) {
      rawSteps = entry.steps;
    } else if (entry.mode === "single") {
      rawSteps = [{ agent: entry.agent, task: entry.task }];
    }

    if (rawSteps.length === 0) {
      ctx.ui.notify("Cannot rerun this history entry: no steps recorded.", "error");
      return;
    }

    const missingAgents: string[] = [];
    const runStepsList: Step[] = [];
    for (const rawStep of rawSteps) {
      const agent = agents.find((a) => a.name === rawStep.agent);
      if (!agent) {
        missingAgents.push(rawStep.agent);
      } else {
        runStepsList.push({ agent, task: rawStep.task });
      }
    }

    if (missingAgents.length > 0) {
      ctx.ui.notify(`Agent(s) not found: ${missingAgents.join(", ")}`, "error");
      return;
    }

    const { results, finalOutput, failedResults } = await executeSteps(
      ctx,
      runStepsList,
      entry.mode,
      entry.cwd,
      entry.extensionsPolicy,
      entry.customExtensions ?? [],
      4,
    );

    const historyEntry: HistoryEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      result: {
        exitCode: failedResults.length > 0 ? 1 : 0,
        outputPreview: finalOutput.slice(0, 2000),
        stderrPreview: results.map((r) => r.stderr).join("\n").slice(0, 1000),
        stopReason: results.map((r) => r.stopReason).filter(Boolean).join(", ") || undefined,
      },
    };
    writeHistoryFile(historyEntry);

    if (failedResults.length > 0) {
      ctx.ui.notify(`${failedResults.length} of ${results.length} step(s) failed.`, "error");
    } else {
      ctx.ui.notify(`${entry.mode === "single" ? "Agent" : entry.mode === "parallel" ? "Parallel run" : "Chain"} completed`, "info");
    }
  } else if (action === "Delete") {
    deleteHistoryFile(fileName);
    ctx.ui.notify("Deleted", "info");
  }
}

async function editAgentExtensions(
  ctx: ExtensionCommandContext,
  settings: SubAgentsSettings,
  agentName: string,
): Promise<void> {
  const perAgent = settings.agentExtensions ?? {};
  const current = perAgent[agentName] ?? {};
  const installed = listInstalledExtensions();

  const policies = ["inherit", "none", "custom"];
  const policyLabels = ["inherit (all active extensions)", "none (isolated)", "custom (select extensions)"];
  const selected = await pickOne(ctx, `${agentName} extensions policy`, policyLabels);
  if (!selected) return;

  const policy = policies[policyLabels.indexOf(selected)] as "inherit" | "none" | "custom";
  let extensions: string[] = current.extensions ?? [];
  if (policy === "custom") {
    const picked = await pickMany(ctx, `${agentName} extensions`, installed, extensions);
    if (picked === undefined) return;
    extensions = picked;
  }

  settings.agentExtensions = { ...perAgent, [agentName]: { policy, extensions } };
}

async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
  const settings = getSettings();
  const agents = await discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    const builtin = await loadBuiltinAgents();
    if (builtin.length > 0) agents.push(...builtin);
  }
  const agentNames = agents.map((a) => a.name);

  while (true) {
    const globalPolicy = formatPolicyLabel(settings.defaultExtensionsPolicy ?? "inherit", settings.defaultCustomExtensions ?? []);

    const perAgentLabels = agentNames.map((name) => {
      const { policy, extensions } = getAgentExtensionDefaults(settings, name);
      return `${name} extensions: ${formatPolicyLabel(policy, extensions)}`;
    });

    const options = [
      `Default cwd: ${settings.defaultCwd || "(current project)"}`,
      `Global extensions: ${globalPolicy}`,
      ...perAgentLabels,
      `History retention: ${settings.historyRetentionDays ?? 30} days`,
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
    } else if (choice.startsWith("Global extensions:")) {
      const policies = ["inherit", "none", "custom"];
      const policyLabels = ["inherit (all active extensions)", "none (isolated)", "custom (select extensions)"];
      const selected = await pickOne(ctx, "Global extensions policy", policyLabels);
      if (!selected) continue;
      settings.defaultExtensionsPolicy = policies[policyLabels.indexOf(selected)] as SubAgentsSettings["defaultExtensionsPolicy"];
      if (settings.defaultExtensionsPolicy === "custom") {
        const installed = listInstalledExtensions();
        const picked = await pickMany(ctx, "Global custom extensions", installed, settings.defaultCustomExtensions ?? []);
        if (picked === undefined) continue;
        settings.defaultCustomExtensions = picked;
      } else {
        settings.defaultCustomExtensions = undefined;
      }
    } else if (choice.startsWith("History retention:")) {
      const value = await editString(ctx, "History retention days (0 = keep forever)", String(settings.historyRetentionDays ?? 30));
      if (value === undefined) continue;
      settings.historyRetentionDays = Math.max(0, Number(value) || 0);
    } else {
      const agentName = agentNames.find((name) => choice.startsWith(`${name} extensions:`));
      if (agentName) {
        await editAgentExtensions(ctx, settings, agentName);
      }
    }
  }
}

export async function runSubAgentsTUI(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/sub-agents requires interactive TUI mode.", "error");
    return;
  }

  while (true) {
    const choice = await pickOne(ctx, "Sub-agents", ["Run task", "Run agent", "Review / Critic", "Recent runs", "Settings", "Help", "Exit"]);
    if (!choice || choice === "Exit") return;

    try {
      if (choice === "Run task") {
        await runTaskInteractive(ctx);
      } else if (choice === "Run agent") {
        await runAgentInteractive(ctx);
      } else if (choice === "Review / Critic") {
        await runCriticInteractive(ctx);
      } else if (choice === "Recent runs") {
        await showRecentRuns(ctx);
      } else if (choice === "Settings") {
        await showSettings(ctx);
      } else if (choice === "Help") {
        const help = [
          "Sub-agents TUI help:",
          "",
          "Run task — pick a predefined task file, fill optional input, and run.",
          "Run agent — pick an agent and write a task.",
          "Review / Critic — review last commit, staged changes, a file, or custom diff/text.",
          "Recent runs — view, rerun or delete previous subagent invocations.",
          "Settings — default cwd, global extensions, and per-agent extension policies.",
          "",
          "Settings are saved in ~/.pi/agent/settings.json under the \"subAgents\" key.",
          "History is stored as one JSON file per run in ~/.pi/agent/sub-agents-history/.",
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
