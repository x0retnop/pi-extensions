import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { discoverAgents, loadBuiltinAgents, type AgentConfig } from "./agents.js";
import * as logger from "./logger.js";
import { getResultOutput, isFailedResult, mapWithConcurrencyLimit, runSingleAgent, type SingleResult, type SubagentMode } from "./runner.js";

const SETTINGS_KEY = "subAgents";
const HISTORY_DIR = path.join(os.homedir(), ".pi", "agent", "sub-agents-history");
const EXTENSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");

export interface SubAgentsSettings {
  defaultCwd?: string;
  defaultExtensionsPolicy?: "inherit" | "none" | "custom";
  defaultCustomExtensions?: string[];
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
    const choice = await ctx.ui.select(`${title} (pick, then choose Done)`, [...items, "Done"]);
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
      (results) => ({
        mode: "single",
        results,
      }),
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
          (results) => ({
            mode: "parallel",
            results,
          }),
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
        (results) => ({
          mode: "chain",
          results,
        }),
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

async function runAgentInteractive(ctx: ExtensionCommandContext): Promise<void> {
  const settings = getSettings();
  const agents = await discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    const builtin = await loadBuiltinAgents();
    if (builtin.length > 0) {
      agents.push(...builtin);
    }
  }
  if (agents.length === 0) {
    ctx.ui.notify("No agents found.", "error");
    return;
  }

  const agentNames = agents.map((a) => a.name);
  const selectedAgentName = await pickOne(ctx, "Select agent", agentNames);
  if (!selectedAgentName) return;

  const agent = agents.find((a) => a.name === selectedAgentName)!;

  const modes: SubagentMode[] = ["single", "parallel", "chain"];
  const mode = (await pickOne(ctx, "Select mode", modes)) as SubagentMode | undefined;
  if (!mode) return;

  const steps: Step[] = [];
  if (mode === "single") {
    const task = await editString(ctx, "Task (one or more lines)", "");
    if (task === undefined) return;
    steps.push({ agent, task });
  } else {
    while (true) {
      const menuTitle = mode === "parallel" ? "Parallel tasks" : "Chain steps";
      const choice = await pickOne(ctx, menuTitle, ["Add step", "Done", "Cancel"]);
      if (!choice || choice === "Cancel") return;
      if (choice === "Done") {
        if (steps.length === 0) {
          ctx.ui.notify("Add at least one step before running.", "error");
          continue;
        }
        break;
      }

      const stepAgentName = await pickOne(ctx, "Select agent for this step", agentNames);
      if (!stepAgentName) continue;
      const stepAgent = agents.find((a) => a.name === stepAgentName)!;
      const task = await editString(ctx, `Task for ${stepAgentName} (one or more lines)`, "");
      if (task === undefined) continue;
      steps.push({ agent: stepAgent, task });
    }
  }

  const policies = ["inherit", "none", "custom"];
  const policyLabels = ["inherit (all active extensions)", "none (isolated)", "custom (select extensions)"];
  const defaultPolicy = settings.defaultExtensionsPolicy ?? "inherit";
  const selectedPolicyLabel = await pickOne(ctx, "Extensions policy", policyLabels);
  if (!selectedPolicyLabel) return;
  const extensionsPolicy = policies[policyLabels.indexOf(selectedPolicyLabel)];

  let customExtensions: string[] = [];
  if (extensionsPolicy === "custom") {
    const installed = listInstalledExtensions();
    const initial = settings.defaultCustomExtensions?.filter((e) => installed.includes(e)) ?? [];
    const picked = await pickMany(ctx, "Select extensions to load", installed, initial);
    if (picked === undefined) return;
    customExtensions = picked;
  }

  const defaultCwd = settings.defaultCwd ?? ctx.cwd;
  const cwd = await editString(ctx, `Working directory (empty = current: ${ctx.cwd})`, defaultCwd);
  if (cwd === undefined) return;

  const effectiveCwd = cwd.trim() || ctx.cwd;

  const cliPreview =
    steps.length === 1
      ? formatCliPreview(steps[0].agent, mode, steps[0].task, effectiveCwd, extensionsPolicy, customExtensions)
      : steps
          .map((step, i) =>
            [`# Step ${i + 1}: ${step.agent.name}`, formatCliPreview(step.agent, mode, step.task, effectiveCwd, extensionsPolicy, customExtensions)].join(
              "\n",
            ),
          )
          .join("\n\n");

  const action = await pickOne(ctx, "Preview / Run", ["Copy CLI", "Run", "Cancel"]);
  if (action === "Copy CLI") {
    await copyToClipboard(cliPreview);
    ctx.ui.notify("CLI copied to clipboard", "info");
    return;
  }
  if (action !== "Run") return;

  await logger.info("TUI run agent", { agent: steps.map((s) => s.agent.name).join(", "), mode, cwd: effectiveCwd, extensionsPolicy }, ctx.cwd);

  const { results, finalOutput, failedResults } = await executeSteps(
    ctx,
    steps,
    mode,
    effectiveCwd,
    extensionsPolicy,
    customExtensions,
  );

  const historyEntry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    agent: steps.map((s) => s.agent.name).join(", "),
    mode,
    task: steps.map((s) => s.task).join("\n---\n"),
    cwd: effectiveCwd,
    extensionsPolicy,
    customExtensions: extensionsPolicy === "custom" ? customExtensions : undefined,
    cliCommand: cliPreview,
    steps: steps.map((s) => ({ agent: s.agent.name, task: s.task })),
    result: {
      exitCode: failedResults.length > 0 ? 1 : 0,
      outputPreview: finalOutput.slice(0, 2000),
      stderrPreview: results.map((r) => r.stderr).join("\n").slice(0, 1000),
      stopReason: results.map((r) => r.stopReason).filter(Boolean).join(", ") || undefined,
    },
  };
  writeHistoryFile(historyEntry);

  settings.lastAgent = steps[0].agent.name;
  settings.lastMode = mode;
  await saveSettings(settings);

  if (failedResults.length > 0) {
    ctx.ui.notify(`${failedResults.length} of ${results.length} step(s) failed.`, "error");
  } else {
    ctx.ui.notify(`${mode === "single" ? "Agent" : mode === "parallel" ? "All parallel agents" : "Chain"} completed`, "info");
  }

  const view = await ctx.ui.confirm("View result?", finalOutput.slice(0, 500));
  if (view) {
    await ctx.ui.editor("Result", finalOutput);
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
      ctx.ui.notify(`${entry.mode === "single" ? "Agent" : entry.mode === "parallel" ? "All parallel agents" : "Chain"} completed`, "info");
    }
  } else if (action === "Delete") {
    deleteHistoryFile(fileName);
    ctx.ui.notify("Deleted", "info");
  }
}

async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
  const settings = getSettings();

  const cwd = await editString(
    ctx,
    "Default working directory (empty = use current project cwd)",
    settings.defaultCwd ?? "",
  );
  if (cwd === undefined) return;

  const policies = ["inherit", "none", "custom"];
  const policyLabels = ["inherit (all active extensions)", "none (isolated)", "custom (select extensions)"];
  const selectedPolicyLabel = await pickOne(ctx, "Default extensions policy", policyLabels);
  if (!selectedPolicyLabel) return;
  const extensionsPolicy = policies[policyLabels.indexOf(selectedPolicyLabel)];

  let customExtensions: string[] = settings.defaultCustomExtensions ?? [];
  if (extensionsPolicy === "custom") {
    const installed = listInstalledExtensions();
    const picked = await pickMany(ctx, "Default custom extensions", installed, customExtensions);
    if (picked === undefined) return;
    customExtensions = picked;
  }

  const retention = await editString(ctx, "History retention days (0 = keep forever)", String(settings.historyRetentionDays ?? 30));
  if (retention === undefined) return;

  settings.defaultCwd = cwd.trim() || undefined;
  settings.defaultExtensionsPolicy = extensionsPolicy as SubAgentsSettings["defaultExtensionsPolicy"];
  settings.defaultCustomExtensions = extensionsPolicy === "custom" ? customExtensions : undefined;
  settings.historyRetentionDays = Math.max(0, Number(retention) || 0);
  await saveSettings(settings);
  ctx.ui.notify("Settings saved", "info");
}

export async function runSubAgentsTUI(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/sub-agents requires interactive TUI mode.", "error");
    return;
  }

  while (true) {
    const choice = await pickOne(ctx, "Sub-agents", ["Run agent", "Recent runs", "Settings", "Help", "Exit"]);
    if (!choice || choice === "Exit") return;

    try {
      if (choice === "Run agent") {
        await runAgentInteractive(ctx);
      } else if (choice === "Recent runs") {
        await showRecentRuns(ctx);
      } else if (choice === "Settings") {
        await showSettings(ctx);
      } else if (choice === "Help") {
        const help = [
          "Sub-agents TUI help:",
          "",
          "Run agent — pick an agent, mode, task, extensions and run or copy CLI.",
          "Recent runs — view, rerun or delete previous subagent invocations.",
          "Settings — default cwd, extensions policy and history retention.",
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
