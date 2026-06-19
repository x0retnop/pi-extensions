import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import * as logger from "./logger.js";

const PER_TASK_OUTPUT_CAP = 50 * 1024;
const STDERR_CAP = 100 * 1024;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SUBAGENT_MAX_TURNS = 50;

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "project" | "builtin" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export type SubagentMode = "single" | "parallel" | "chain";

export interface SubagentDetails {
  mode: SubagentMode;
  results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function buildPiArgs(agent: AgentConfig, promptPath: string | null): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  if (agent.extensions && agent.extensions.length > 0) {
    args.push("--no-extensions");
    for (const ext of agent.extensions) {
      const extPath = path.isAbsolute(ext)
        ? ext
        : path.join(os.homedir(), ".pi", "agent", "extensions", ext);
      args.push("--extension", extPath);
    }
  } else if (!agent.includeExtensions) {
    args.push("--no-extensions");
  }

  if (promptPath) args.push("--append-system-prompt", promptPath);
  return args;
}

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const startTs = Date.now();
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildPiArgs(agent, tmpPromptPath);
    const invocation = getPiInvocation(args);

    await logger.debug("Spawning subagent", {
      agent: agentName,
      cwd: cwd ?? defaultCwd,
      command: invocation.command,
      args: invocation.args,
      taskLength: task.length,
      model: agent.model,
      tools: agent.tools,
      includeExtensions: agent.includeExtensions,
    }, defaultCwd);

    let wasAborted = false;
    let wasKilledByGuard = false;

    const timeoutMs = agent.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    const maxTurns = agent.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PI_SUB_AGENTS_CHILD: "1" },
      });

      let sigkillTimer: NodeJS.Timeout | null = null;
      const clearSigkillTimer = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
      };
      let abortHandler: (() => void) | null = null;

      const killProc = (reason: string) => {
        if (wasAborted || wasKilledByGuard || proc.killed) return;
        wasKilledByGuard = true;
        logger.warn("Killing subagent", { agent: agentName, reason }, defaultCwd).catch(() => {});
        proc.kill("SIGTERM");
        clearSigkillTimer();
        sigkillTimer = setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };

      const timeout = setTimeout(() => killProc(`timeout after ${timeoutMs}ms`), timeoutMs);

      const checkTurns = () => {
        if (currentResult.usage.turns >= maxTurns) {
          killProc(`maxTurns reached (${maxTurns})`);
        }
      };

      proc.stdin.write(task, "utf-8", (err) => {
        if (err) {
          logger.error("Subagent stdin write error", { agent: agentName, error: err.message }, defaultCwd).catch(() => {});
        }
        proc.stdin.end();
      });

      proc.stdin.on("error", (err) => {
        logger.error("Subagent stdin error", { agent: agentName, error: err.message }, defaultCwd).catch(() => {});
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch (err) {
          logger.debug("Subagent stdout JSON parse error", { agent: agentName, line: line.slice(0, 200), error: (err as Error).message }, defaultCwd).catch(() => {});
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          checkTurns();
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      let stderrBytes = 0;

      proc.stderr.on("data", (data) => {
        if (stderrBytes >= STDERR_CAP) return;
        const chunk = data.toString();
        currentResult.stderr += chunk;
        stderrBytes += Buffer.byteLength(chunk, "utf8");
        if (stderrBytes > STDERR_CAP) {
          const buf = Buffer.from(currentResult.stderr, "utf8");
          currentResult.stderr = buf.slice(0, STDERR_CAP).toString("utf8") + "\n[stderr truncated]";
          stderrBytes = STDERR_CAP;
        }
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        clearSigkillTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        clearSigkillTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        logger.error("Subagent spawn error", { agent: agentName, error: err.message }, defaultCwd).catch(() => {});
        resolve(1);
      });

      if (signal) {
        abortHandler = () => {
          wasAborted = true;
          clearTimeout(timeout);
          clearSigkillTimer();
          proc.kill("SIGTERM");
          sigkillTimer = setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    const durationMs = Date.now() - startTs;
    await logger.debug("Subagent finished", {
      agent: agentName,
      exitCode,
      stopReason: currentResult.stopReason,
      errorMessage: currentResult.errorMessage,
      usage: currentResult.usage,
      durationMs,
      output: getResultOutput(currentResult).slice(0, 2000),
      stderr: currentResult.stderr.slice(0, 1000),
    }, defaultCwd);

    if (wasKilledByGuard) throw new Error(`Subagent killed by guard: timeout=${timeoutMs}ms, maxTurns=${maxTurns}`);
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    currentResult.errorMessage = message;
    currentResult.exitCode = currentResult.exitCode || 1;
    await logger.error("Subagent error", { agent: agentName, error: message }, defaultCwd);
    return currentResult;
  } finally {
    if (tmpPromptDir) {
      await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}
