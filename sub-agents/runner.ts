import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatDuration } from "../common/duration.js";
import {
  RESPAWN_DELAYS_MS,
  delayForAttempt,
  isHardStopError,
  isPayloadRejectionError,
} from "../common/retry-policy.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import * as logger from "./logger.js";
import { resolveModelContextWindow, getSettings, TOOL_EXTENSION_MAP } from "./settings.js";

const STDERR_CAP = 100 * 1024;
const TRANSCRIPT_DIR = path.join(os.homedir(), ".pi", "agent", "sub-agents-history");

// ── Guards ──────────────────────────────────────────────────────────
// One attempt runs under four layers. Everything except the context cap
// is evaluated against observed activity, not wall clock:
//   deadline  — soft budget, extended by its own length on progress
//   idle      — no stdout bytes at all: wedged child / dead provider
//   tool idle — same, but a tool call is in flight (long builds are normal)
//   hard      — wall-clock and turn caps; nothing extends them directly, but
//               each cap grants an extension (+50% of its base value, up to
//               `maxExtensions` times) when a turn completed recently — a
//               productive run is not cut off mid-work, a stalled one gets
//               nothing and is killed by the idle/deadline layers first.

/** Defaults; `timeoutMs` and `maxTurns` in frontmatter/overrides map to hardMs/maxTurns. */
export const GUARD_DEFAULTS = {
  /** Absolute wall-clock ceiling for one attempt. */
  hardMs: 60 * 60 * 1000,
  /** Absolute assistant-turn ceiling for one attempt. */
  maxTurns: 300,
  /** Soft deadline: stops a run that completes no turn for this long. */
  deadlineMs: 20 * 60 * 1000,
  /** Silence with no tool running. Must stay above Pi's own 5 min httpIdleTimeoutMs. */
  idleMs: 10 * 60 * 1000,
  /** Silence while a tool runs — a long build or test is legitimate. */
  toolIdleMs: 30 * 60 * 1000,
  /** Stop once the child's context reaches this share of its window. 0 disables the check. */
  contextLimitPercent: 40,
  /** How many times a fired hard/turn cap is converted into an extension. 0 = never extend. */
  maxExtensions: 2,
  /** A cap extends only if a turn completed within this window (ms). 0 = never extend. */
  extendGraceMs: 10 * 60 * 1000,
} as const;

/** Share of the base cap that one extension grants. */
const EXTEND_RATIO = 0.5;

/** How often the guards are evaluated. */
const GUARD_TICK_MS = 5000;

export interface GuardLimits {
  hardMs: number;
  maxTurns: number;
  deadlineMs: number;
  idleMs: number;
  toolIdleMs: number;
  contextLimitPercent: number;
  maxExtensions: number;
  extendGraceMs: number;
}

/** Everything the guards need, sampled fresh on every tick. */
export interface GuardSnapshot {
  startedAt: number;
  /** Last stdout byte from the child (streaming deltas count). */
  lastOutputAt: number;
  /** Last completed assistant turn — the progress signal for cap extensions. */
  lastTurnAt: number;
  /** When the guards would currently stop a run that makes no further progress. */
  deadlineAt: number;
  /** Tool calls started and not yet finished. */
  toolsInFlight: number;
  turns: number;
  /** Context used by the last assistant turn, as a share of the child's window. */
  contextPercent?: number;
  contextWindow?: number;
  /** Hard/turn cap extensions already granted this attempt. */
  extensionsUsed: number;
}

/**
 * Deadline for a run that just made progress. Progress pushes the deadline one
 * full `deadlineMs` ahead of now, but never past the hard ceiling — so real work
 * extends the budget and a stalled run still ends. A disabled ceiling (`hardMs`
 * 0) never clamps.
 */
export function nextDeadline(now: number, startedAt: number, limits: GuardLimits): number {
  if (limits.hardMs <= 0) return now + limits.deadlineMs;
  return Math.min(now + limits.deadlineMs, startedAt + limits.hardMs);
}

/**
 * Re-anchor the deadline after a progress event (completed turn, finished tool
 * call) or after a cap extension was granted.
 *
 * Must be called with the **effective** limits: clamping to the base `hardMs`
 * once the base ceiling has passed and an extension was granted puts the
 * deadline in the past, and the next tick then stops a healthy run with
 * `no completed turn for <deadlineMs>` seconds after it made progress.
 */
export function progressDeadline(now: number, startedAt: number, limits: GuardLimits, extensionsUsed: number): number {
  return nextDeadline(now, startedAt, { ...limits, hardMs: effectiveHardMs(limits, extensionsUsed) });
}

/** Human durations for guard messages/labels live in common/duration.ts; re-exported for callers. */
export { formatDuration };

/**
 * Effective hard caps after granted extensions. Each extension adds 50% of the
 * base value; `maxExtensions` 2 doubles the ceiling at most. A base cap of 0
 * (not reachable via frontmatter, kept for completeness) stays disabled.
 */
export function effectiveHardMs(limits: GuardLimits, extensionsUsed: number): number {
  if (limits.hardMs <= 0) return 0;
  return limits.hardMs + Math.floor(limits.hardMs * EXTEND_RATIO) * extensionsUsed;
}

export function effectiveMaxTurns(limits: GuardLimits, extensionsUsed: number): number {
  if (limits.maxTurns <= 0) return 0;
  return Math.floor(limits.maxTurns * (1 + EXTEND_RATIO * extensionsUsed));
}

/** Suffix for cap reasons after extensions: ` (incl. 1 extension)`. */
function extensionNote(extensionsUsed: number): string {
  return extensionsUsed > 0 ? ` (incl. ${extensionsUsed} extension${extensionsUsed === 1 ? "" : "s"})` : "";
}

export interface GuardDecision {
  /** Stop reason, or null to keep running. */
  reason: string | null;
  /** Which hard cap fired — only set when `reason` names a hard/turn cap. */
  cap: "turns" | "time" | null;
}

/**
 * Pure guard evaluation. Returns the stop decision; `cap` marks a fired
 * hard/turn cap so the caller can convert it into an extension instead of a
 * kill. Order matters: absolute caps first, then context, then silence.
 */
export function evaluateGuards(now: number, snapshot: GuardSnapshot, limits: GuardLimits): GuardDecision {
  const maxTurns = effectiveMaxTurns(limits, snapshot.extensionsUsed);
  if (maxTurns > 0 && snapshot.turns >= maxTurns) {
    return { reason: `turn cap reached (${maxTurns}${extensionNote(snapshot.extensionsUsed)})`, cap: "turns" };
  }
  const hardMs = effectiveHardMs(limits, snapshot.extensionsUsed);
  if (hardMs > 0 && now - snapshot.startedAt >= hardMs) {
    return { reason: `hard limit reached (${formatDuration(hardMs)}${extensionNote(snapshot.extensionsUsed)})`, cap: "time" };
  }
  const percent = snapshot.contextPercent;
  if (limits.contextLimitPercent > 0 && percent !== undefined && percent >= limits.contextLimitPercent) {
    const window = snapshot.contextWindow ? ` of ${snapshot.contextWindow.toLocaleString()}` : "";
    return { reason: `context at ${percent.toFixed(0)}%${window} (limit ${limits.contextLimitPercent}%)`, cap: null };
  }

  // While a tool runs, silence is expected (a build or a test suite); the
  // deadline is suspended too, because a turn cannot complete until it returns.
  const toolBusy = snapshot.toolsInFlight > 0;
  const silenceMs = now - snapshot.lastOutputAt;
  const idleLimit = toolBusy ? limits.toolIdleMs : limits.idleMs;
  if (limits.idleMs > 0 && silenceMs >= idleLimit) {
    return {
      reason: toolBusy
        ? `tool silent for ${formatDuration(silenceMs)}`
        : `no output for ${formatDuration(silenceMs)}`,
      cap: null,
    };
  }
  if (!toolBusy && limits.deadlineMs > 0 && now >= snapshot.deadlineAt) {
    return { reason: `no completed turn for ${formatDuration(limits.deadlineMs)}`, cap: null };
  }
  return { reason: null, cap: null };
}

/**
 * May a fired hard/turn cap be converted into an extension? Only while
 * extensions remain and a turn completed within the grace window — streaming
 * bytes without a finished turn do not count. A stalled or thrashing child
 * never qualifies, so the anti-hang protection is unchanged.
 */
export function canExtendCap(now: number, snapshot: GuardSnapshot, limits: GuardLimits): boolean {
  if (limits.maxExtensions <= 0 || limits.extendGraceMs <= 0) return false;
  if (snapshot.extensionsUsed >= limits.maxExtensions) return false;
  return now - snapshot.lastTurnAt <= limits.extendGraceMs;
}

/** Effective limits for one attempt: frontmatter/overrides, then code defaults. */
export function resolveGuardLimits(agent: AgentConfig): GuardLimits {
  return {
    hardMs: agent.timeoutMs ?? GUARD_DEFAULTS.hardMs,
    maxTurns: agent.maxTurns ?? GUARD_DEFAULTS.maxTurns,
    deadlineMs: agent.deadlineMs ?? GUARD_DEFAULTS.deadlineMs,
    idleMs: agent.idleMs ?? GUARD_DEFAULTS.idleMs,
    toolIdleMs: agent.toolIdleMs ?? GUARD_DEFAULTS.toolIdleMs,
    contextLimitPercent: agent.contextLimitPercent ?? GUARD_DEFAULTS.contextLimitPercent,
    maxExtensions: agent.maxExtensions ?? GUARD_DEFAULTS.maxExtensions,
    extendGraceMs: agent.extendGraceMs ?? GUARD_DEFAULTS.extendGraceMs,
  };
}

/** Live progress for the parent UI; sampled on every guard tick. */
export interface RunProgress {
  elapsedMs: number;
  sinceOutputMs: number;
  toolsInFlight: number;
  turns: number;
  contextPercent?: number;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface GuardInterrupt {
  /** Human-readable guard reason, e.g. `deadline reached (20 min) with no progress`. */
  reason: string;
  elapsedMs: number;
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
  transcriptPath?: string;
  /** Wall-clock runtime of the attempt; rendered in the parent's tool block. */
  durationMs?: number;
  /** Set when a guard stopped the attempt; partial output is still in `messages`. */
  interrupted?: GuardInterrupt;
  /** Retries the child burned on its own (its `settings.retry` budget). */
  childRetries?: number;
  /** Child session id — the handle that makes a respawn a continuation. */
  sessionId?: string;
}

export type SubagentMode = "single" | "parallel" | "chain";

export interface SubagentDetails {
  mode: SubagentMode;
  results: SingleResult[];
  /** Agent name, task and effective config captured at call time for rendering. */
  agentName?: string;
  task?: string;
  resolved?: { model?: string; role?: string; tools?: string[]; filePath?: string };
  /** Sampled while the run is in flight; absent on the final result. */
  progress?: RunProgress;
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

/**
 * Text handed to the parent. An attempt stopped by a guard is still a failure,
 * but its partial output is returned instead of being thrown away — the child
 * usually wrote something useful before it was stopped.
 */
export function getResultOutput(result: SingleResult): string {
  const finalOutput = getFinalOutput(result.messages);
  if (result.interrupted) {
    const header = `[stopped by guard: ${result.interrupted.reason} after ${formatDuration(result.interrupted.elapsedMs)}]`;
    const parts = [header];
    if (finalOutput.trim()) parts.push(finalOutput);
    if (result.transcriptPath) parts.push(`Transcript: ${result.transcriptPath}`);
    return parts.join("\n\n");
  }
  if (isFailedResult(result)) {
    const text = result.errorMessage || result.stderr || finalOutput || "(no output)";
    // The transcript holds the run's full brief — the parent's only recovery
    // handle when the orchestrator re-spawns after a failure.
    return result.transcriptPath ? `${text}\n\nTranscript: ${result.transcriptPath}` : text;
  }
  return finalOutput || "(no output)";
}

/**
 * Extra process respawns after a provider/transport blip. Each respawn RESUMES
 * the same child session, so the child keeps its reads, its reasoning and its
 * own record of what it already changed — a mid-run blip no longer costs the
 * whole delegated task, and no edit is applied twice.
 *
 * Delays come from the shared ladder (`common/retry-policy.ts`): Pi already
 * burned the fast rungs in-run, so these are the slow ones.
 */
const SPAWN_RETRY_EXTRA = RESPAWN_DELAYS_MS.length;

/** Child sessions live in their own folder: the user's session stats/triage stay clean. */
export const CHILD_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "subagent-sessions");

/** Id shared by every attempt of one run — that is what makes a respawn a continuation. */
export function makeChildSessionId(agentName: string): string {
  const slug = agentName.replace(/[^\w.-]+/g, "_").slice(0, 24) || "agent";
  return `sub-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Prompt for attempt N>1. The child still owns the conversation, so this is a
 * nudge, not a brief: name the failure, forbid redoing finished work, and force
 * a state check before the next edit (a run can stop between a write and its
 * verification).
 */
export function buildResumePrompt(errorMessage: string | undefined, attempt: number): string {
  const why = (errorMessage || "unknown error").replace(/\s+/g, " ").slice(0, 300);
  return [
    `Your previous turn failed with: ${why}`,
    `Resume the same task (attempt ${attempt}). The conversation so far is yours — do not re-read files you have already read, do not redo work you have already finished.`,
    `Check the current state of the working tree before the next edit; the run may have stopped between a change and its verification.`,
    `Then continue from where it stopped and finish with your normal report.`,
  ].join("\n");
}

/**
 * Provider/transport blip: respawn the child process, resuming its session.
 * Stops only on the shared hard list (quota / money / auth / invalid request /
 * context overflow) plus abort and guard stops; everything unrecognised is
 * retried, because providers invent transient wordings faster than any list.
 */
export function shouldRetrySpawn(result: SingleResult): boolean {
  if (!isFailedResult(result)) return false;
  if (result.interrupted) return false;
  if (result.errorMessage === "Subagent was aborted") return false;
  if (result.errorMessage?.startsWith("Subagent stopped by guard")) return false;
  if (result.errorMessage?.startsWith("Subagent killed by guard")) return false;
  return !isHardStopError(`${result.errorMessage ?? ""} ${result.stderr ?? ""}`);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(true), ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

// ── Transcript logging ──────────────────────────────────────────────
// Every run (TUI, spawn_agent, /handoff) writes a readable markdown
// transcript to ~/.pi/agent/sub-agents-history/*.transcript.md.

const TRANSCRIPT_ARG_CAP = 1000;
const TRANSCRIPT_RESULT_CAP = 2000;
const TRANSCRIPT_STDERR_CAP = 4000;
const TRANSCRIPT_FINAL_CAP = 20000;
const TRANSCRIPT_TOTAL_CAP = 1024 * 1024;

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
}

/**
 * Wrap model-authored markdown so its own `#` headings and ``` fences cannot be
 * mistaken for this file's sections (the brief and the report are both markdown).
 */
function fence(text: string): string {
  const runs: string[] = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}\n${text}\n${bar}`;
}

function renderTranscriptMessage(msg: Message, index: number): string {
  const anyMsg = msg as any;

  if (anyMsg.role === "assistant") {
    const parts: string[] = [`### [${index}] assistant`];
    for (const part of anyMsg.content ?? []) {
      if (part.type === "text" && part.text?.trim()) {
        parts.push(cap(part.text.trim(), TRANSCRIPT_RESULT_CAP));
      } else if (part.type === "toolCall") {
        const args = cap(JSON.stringify(part.arguments ?? {}, null, 2), TRANSCRIPT_ARG_CAP);
        parts.push(`**tool_call: ${part.name}**\n\`\`\`json\n${args}\n\`\`\``);
      }
    }
    return parts.join("\n\n");
  }

  if (anyMsg.role === "toolResult") {
    const texts = (anyMsg.content ?? [])
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");
    return `### [${index}] toolResult (${anyMsg.toolName ?? "?"})\n\`\`\`\n${cap(texts || "(empty)", TRANSCRIPT_RESULT_CAP)}\n\`\`\``;
  }

  return "";
}

export function formatTranscript(
  result: SingleResult,
  agent: AgentConfig,
  task: string,
  cwd: string,
  durationMs: number,
  attempt = 1,
): string {
  const u = result.usage;
  const parts: string[] = [];

  parts.push(
    [
      "# Sub-agent transcript",
      "",
      `- **Agent:** ${agent.name} (${agent.source})`,
      `- **Model:** ${result.model ?? agent.model ?? "default"}`,
      `- **Role:** ${agent.role ?? "none"}`,
      `- **Tools:** ${agent.tools?.join(", ") ?? "default"}`,
      `- **CWD:** ${cwd}`,
      `- **Attempt:** ${attempt}`,
      `- **Duration:** ${(durationMs / 1000).toFixed(1)}s`,
      `- **Exit code:** ${result.exitCode}${result.stopReason ? `, stopReason: ${result.stopReason}` : ""}`,
      result.sessionId ? `- **Child session:** ${result.sessionId}` : "",
      result.childRetries ? `- **Child retries:** ${result.childRetries}` : "",
      result.interrupted ? `- **Stopped by guard:** ${result.interrupted.reason}` : "",
      result.errorMessage && !(result.interrupted && result.errorMessage.startsWith("Subagent stopped by guard"))
        ? `- **Error:** ${result.errorMessage}`
        : "",
      `- **Usage:** input=${u.input}, output=${u.output}, cacheRead=${u.cacheRead}, cost=$${u.cost.toFixed(4)}, turns=${u.turns}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  // The brief is the parent's own words — the only full copy outside the session
  // log, and the thing a parent re-reads after its own context was trimmed.
  parts.push(`## Prompt (brief)\n\n${fence(task)}`);

  if (result.stderr.trim()) {
    parts.push(`## Stderr\n\n${fence(cap(result.stderr.trim(), TRANSCRIPT_STDERR_CAP))}`);
  }

  const body = result.messages
    .map((m, i) => renderTranscriptMessage(m, i))
    .filter(Boolean)
    .join("\n\n");
  if (body) parts.push(`## Messages\n\n${body}`);

  parts.push(`## Final message\n\n${fence(cap(getResultOutput(result), TRANSCRIPT_FINAL_CAP))}`);

  return cap(`${parts.join("\n\n")}\n`, TRANSCRIPT_TOTAL_CAP);
}

async function writeTranscript(
  result: SingleResult,
  agent: AgentConfig,
  task: string,
  cwd: string,
  startTs: number,
  attempt = 1,
): Promise<string | undefined> {
  try {
    await fs.promises.mkdir(TRANSCRIPT_DIR, { recursive: true });
    const safeAgent = agent.name.replace(/[^\w.-]+/g, "_");
    const stamp =
      new Date(startTs).toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "") +
      `-${String(startTs % 1000).padStart(3, "0")}`;
    const filePath = path.join(TRANSCRIPT_DIR, `${stamp}-${safeAgent}.transcript.md`);
    await fs.promises.writeFile(
      filePath,
      formatTranscript(result, agent, task, cwd, Date.now() - startTs, attempt),
      "utf-8",
    );
    return filePath;
  } catch (err) {
    // Transcript logging must never crash a run, but failures should be visible.
    const message = err instanceof Error ? err.message : String(err);
    await logger.error("Failed to write transcript", { agent: agent.name, error: message }, cwd);
    return undefined;
  }
}

/** Single source of truth for the child CLI invocation (TUI preview). */
export function buildPiArgsPreview(agent: AgentConfig): string {
  const session: ChildSession = { id: "sub-<agent>-<run>", dir: CHILD_SESSION_DIR };
  const args = buildPiArgs(agent, agent.systemPrompt.trim() ? "<prompt-file>" : null, session);
  const env = agent.role ? `PI_SUB_AGENT_ROLE=${agent.role} ` : "";
  return `${env}pi ${args.join(" ")}`;
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

function resolveExtensionPath(ext: string): string {
  return path.isAbsolute(ext) ? ext : path.join(os.homedir(), ".pi", "agent", "extensions", ext);
}

/** Determine which extensions must be explicitly loaded so that custom tools
 *  listed in `tools` are available in the child process.
 */
export function requiredExtensionsForTools(tools: string[] | undefined): string[] {
  const needed = new Set<string>();
  for (const tool of tools ?? []) {
    const ext = TOOL_EXTENSION_MAP[tool];
    if (ext) needed.add(ext);
  }
  return Array.from(needed);
}

/** Child `pi` invocation needs a session id + dir to be resumable. */
export interface ChildSession {
  id: string;
  dir: string;
}

/** Build child `pi` CLI args. Exported for unit tests and TUI preview. */
export function buildPiArgs(agent: AgentConfig, promptPath: string | null, session?: ChildSession): string[] {
  const args: string[] = ["--mode", "json", "-p", "--exclude-tools", "spawn_agent"];
  // A named session is what turns a respawn into a continuation: `--session-id`
  // opens the existing child session, or creates it on the first attempt.
  if (session) {
    args.push("--session-id", session.id, "--session-dir", session.dir);
  } else {
    args.push("--no-session");
  }
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  if (agent.role) {
    // Role-driven agents get their system prompt fully composed by role-sw
    // inside the child; context files and skills would only pollute it.
    args.push("--no-context-files", "--no-skills");
  }

  // If the agent does not load all extensions, make sure any custom tools
  // it requests (e.g. pwsh/py from pi-agent-run) still get their provider
  // loaded in the child.
  const extraExtensions = agent.includeExtensions ? [] : requiredExtensionsForTools(agent.tools);
  const explicitExtensions = new Set(agent.extensions ?? []);
  for (const ext of extraExtensions) explicitExtensions.add(ext);
  const extensions = Array.from(explicitExtensions);

  if (extensions.length > 0) {
    args.push("--no-extensions");
    for (const ext of extensions) {
      args.push("--extension", resolveExtensionPath(ext));
    }
  } else if (!agent.includeExtensions) {
    args.push("--no-extensions");
  }

  if (promptPath) args.push("--append-system-prompt", promptPath);
  return args;
}

async function runSingleAgentOnce(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  attempt = 1,
  /** What goes to the child's stdin: the full brief on attempt 1, a resume nudge afterwards. */
  attemptPrompt?: string,
  /** Named child session — the same id on every attempt is what makes a respawn a continuation. */
  session?: ChildSession,
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
      durationMs: Date.now() - startTs,
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
    sessionId: session?.id,
  };

  // ── Guard state (one attempt) ────────────────────────────────────
  const limits = resolveGuardLimits(agent);
  const startedAt = Date.now();
  /** Progress clock: pushed forward by every completed turn or tool call. */
  let lastOutputAt = startedAt;
  /** Last completed assistant turn — the signal for cap extensions. */
  let lastTurnAt = startedAt;
  let deadlineAt = nextDeadline(startedAt, startedAt, limits);
  /** Hard/turn cap extensions already granted this attempt. */
  let extensionsUsed = 0;
  const toolsInFlight = new Set<string>();
  let contextWindow: number | undefined;
  let contextPercent: number | undefined;
  /** Resolved once per (provider, model) pair; the child reports both. */
  let windowLookedUp = false;
  /** Set when the guards stop the attempt; the partial output is kept. */
  let guardReason: string | null = null;

  const currentProgress = (): RunProgress => ({
    elapsedMs: Date.now() - startedAt,
    sinceOutputMs: Date.now() - lastOutputAt,
    toolsInFlight: toolsInFlight.size,
    turns: currentResult.usage.turns,
    contextPercent,
  });

  const emitUpdate = () => {
    if (onUpdate) {
      const details = makeDetails([currentResult]);
      details.progress = currentProgress();
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details,
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildPiArgs(agent, tmpPromptPath, session);
    const invocation = getPiInvocation(args);

    await logger.debug("Spawning subagent", {
      agent: agentName,
      cwd: cwd || defaultCwd,
      command: invocation.command,
      args: invocation.args,
      taskLength: task.length,
      model: agent.model,
      tools: agent.tools,
      includeExtensions: agent.includeExtensions,
    }, defaultCwd);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd || defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_SUB_AGENTS_CHILD: "1",
          // Consumed by role-sw inside the child to compose the system prompt.
          ...(agent.role ? { PI_SUB_AGENT_ROLE: agent.role } : {}),
          ...(agent.role && tmpPromptPath ? { PI_SUB_AGENT_PROMPT_FILE: tmpPromptPath } : {}),
        },
      });

      let sigkillTimer: NodeJS.Timeout | null = null;
      const clearSigkillTimer = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
      };
      let abortHandler: (() => void) | null = null;
      let ticker: NodeJS.Timeout | null = null;
      const clearTicker = () => {
        if (ticker) {
          clearInterval(ticker);
          ticker = null;
        }
      };

      /**
       * Terminate the child and everything it spawned.
       *
       * On Windows `child.kill('SIGTERM')` is TerminateProcess on the direct
       * child alone: the child's own signal handlers never run, so the `bash`
       * processes it detached survive and keep burning CPU. `taskkill /T` walks
       * the whole tree; `/F` because there is no graceful path on Windows anyway.
       */
      const killTree = (reason: string) => {
        const pid = proc.pid;
        logger.warn("Killing subagent", { agent: agentName, reason, pid }, defaultCwd).catch(() => {});
        if (pid === undefined) return;
        if (process.platform === "win32") {
          try {
            spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
              .once("error", () => {});
          } catch {
            // fall through to the generic kill below
          }
          return;
        }
        try {
          proc.kill("SIGTERM");
        } catch {
          // already gone
        }
        clearSigkillTimer();
        sigkillTimer = setTimeout(() => {
          try {
            if (!proc.killed) proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 5000);
      };

      const stopByGuard = (reason: string) => {
        if (wasAborted || guardReason || proc.killed) return;
        guardReason = reason;
        killTree(reason);
      };

      /** Guards are evaluated on a timer and right after each completed turn. */
      const evaluateNow = () => {
        if (guardReason || wasAborted) return;
        const now = Date.now();
        const snapshot: GuardSnapshot = {
          startedAt,
          lastOutputAt,
          lastTurnAt,
          deadlineAt,
          toolsInFlight: toolsInFlight.size,
          turns: currentResult.usage.turns,
          contextPercent,
          contextWindow,
          extensionsUsed,
        };
        const decision = evaluateGuards(now, snapshot, limits);
        if (!decision.reason) return;
        // A fired hard/turn cap becomes an extension when the run is provably
        // productive (a turn just completed). The deadline re-anchors at the
        // extended ceiling so it stops clamping to the old hard limit.
        if (decision.cap && canExtendCap(now, snapshot, limits)) {
          extensionsUsed++;
          deadlineAt = progressDeadline(now, startedAt, limits, extensionsUsed);
          logger.warn(
            "Guard cap extended — recent progress",
            {
              agent: agentName,
              cap: decision.cap,
              extensionsUsed,
              maxExtensions: limits.maxExtensions,
              lastTurnAgoMs: now - lastTurnAt,
            },
            defaultCwd,
          ).catch(() => {});
          emitUpdate();
          return;
        }
        stopByGuard(decision.reason);
      };

      const markProgress = () => {
        const now = Date.now();
        lastOutputAt = now;
        // Effective limits: a granted extension raises the ceiling the deadline clamps to.
        deadlineAt = progressDeadline(now, startedAt, limits, extensionsUsed);
      };

      ticker = setInterval(() => {
        evaluateNow();
        emitUpdate();
      }, GUARD_TICK_MS);

      proc.stdin.write(attemptPrompt ?? task, "utf-8", (err) => {
        if (err) {
          logger.error("Subagent stdin write error", { agent: agentName, error: err.message }, defaultCwd).catch(() => {});
        }
        proc.stdin.end();
      });

      proc.stdin.on("error", (err) => {
        logger.error("Subagent stdin error", { agent: agentName, error: err.message }, defaultCwd).catch(() => {});
      });

      let rawBuf = Buffer.alloc(0);
      let parseErrors = 0;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch (err) {
          parseErrors++;
          logger.debug("Subagent stdout JSON parse error", { agent: agentName, line: line.slice(0, 200), error: (err as Error).message }, defaultCwd).catch(() => {});
          return;
        }

        // The child retries transient errors itself with the same settings.retry as
        // the parent. Count them: the respawn loop is the slow layer and must not
        // stack a second fast retry on top of the child's own budget.
        if (event.type === "auto_retry_start") {
          currentResult.childRetries = (currentResult.childRetries ?? 0) + 1;
          logger
            .warn(
              "Subagent in-run retry",
              {
                agent: agentName,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                error: typeof event.errorMessage === "string" ? event.errorMessage.slice(0, 300) : undefined,
              },
              defaultCwd,
            )
            .catch(() => {});
        }
        if (event.type === "auto_retry_end" && event.success === false) {
          logger
            .warn(
              "Subagent in-run retries exhausted",
              {
                agent: agentName,
                attempts: event.attempt,
                error: typeof event.finalError === "string" ? event.finalError.slice(0, 300) : undefined,
              },
              defaultCwd,
            )
            .catch(() => {});
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
              // Context accounting mirrors the runtime's calculateContextTokens:
              // the provider's totalTokens for the turn, or the sum of its parts.
              const contextTokens =
                usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
              const provider = (msg as { provider?: string }).provider;
              if (!windowLookedUp && provider && msg.model) {
                windowLookedUp = true;
                contextWindow = resolveModelContextWindow(provider, msg.model);
                if (!contextWindow) {
                  logger.debug("Context guard off: unknown context window", { agent: agentName, model: `${provider}/${msg.model}` }, defaultCwd).catch(() => {});
                }
              }
              if (contextWindow && contextTokens > 0) {
                contextPercent = (contextTokens / contextWindow) * 100;
              }
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
            lastTurnAt = Date.now();
            markProgress();
          }
          evaluateNow();
          emitUpdate();
        }

        // Tool lifecycle drives the "a build is running" exception in the idle
        // guard. Results arrive as message_end/toolResult (see above).
        if (event.type === "tool_execution_start" && event.toolCallId) {
          toolsInFlight.add(event.toolCallId);
        }
        if (event.type === "tool_execution_end" && event.toolCallId) {
          toolsInFlight.delete(event.toolCallId);
          markProgress();
          evaluateNow();
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        // Any byte from the child, including streaming deltas, proves the child
        // is alive — that is what the idle guard measures.
        lastOutputAt = Date.now();
        // Accumulate raw bytes and split on \n byte-wise: a multi-byte UTF-8
        // char split across chunks would otherwise corrupt the line and get
        // silently dropped by JSON.parse.
        rawBuf = Buffer.concat([rawBuf, data]);
        let idx: number;
        while ((idx = rawBuf.indexOf(0x0a)) !== -1) {
          const line = rawBuf.subarray(0, idx).toString("utf-8");
          rawBuf = rawBuf.subarray(idx + 1);
          processLine(line);
        }
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
        clearTicker();
        clearSigkillTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        if (rawBuf.length && rawBuf.toString("utf-8").trim()) processLine(rawBuf.toString("utf-8"));
        if (parseErrors > 0) {
          currentResult.stderr += `\n[warn] ${parseErrors} stdout line(s) failed JSON parse and were dropped`;
        }

        // Determine the final state inside the close handler while process state
        // and guard/abort flags are synchronized. This avoids a race where an abort
        // signal fired after the process already exited would falsely override a
        // successful run.
        if (guardReason) {
          currentResult.exitCode = code ?? 1;
          // Keep guardReason and elapsed time on the result: the partial output
          // is still in `messages` and is returned to the parent.
          currentResult.interrupted = { reason: guardReason, elapsedMs: Date.now() - startTs };
          currentResult.errorMessage = `Subagent stopped by guard: ${guardReason}`;
        } else if (wasAborted) {
          currentResult.exitCode = code ?? 1;
          currentResult.errorMessage = "Subagent was aborted";
        } else {
          currentResult.exitCode = code ?? 0;
        }
        resolve(currentResult.exitCode);
      });

      proc.on("error", (err) => {
        clearTicker();
        clearSigkillTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        logger.error("Subagent spawn error", { agent: agentName, error: err.message }, defaultCwd).catch(() => {});
        currentResult.exitCode = 1;
        currentResult.errorMessage = err.message;
        resolve(1);
      });

      if (signal) {
        abortHandler = () => {
          wasAborted = true;
          clearTicker();
          killTree("aborted by parent");
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    const durationMs = Date.now() - startTs;
    currentResult.durationMs = durationMs;
    await logger.debug("Subagent finished", {
      agent: agentName,
      exitCode: currentResult.exitCode,
      stopReason: currentResult.stopReason,
      errorMessage: currentResult.errorMessage,
      usage: currentResult.usage,
      durationMs,
      output: getResultOutput(currentResult).slice(0, 2000),
      stderr: currentResult.stderr.slice(0, 1000),
    }, defaultCwd);

    currentResult.transcriptPath = await writeTranscript(currentResult, agent, task, cwd || defaultCwd, startTs, attempt);
    return currentResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    currentResult.errorMessage = message;
    currentResult.exitCode = currentResult.exitCode || 1;
    currentResult.durationMs = Date.now() - startTs;
    await logger.error("Subagent error", { agent: agentName, error: message }, defaultCwd);
    currentResult.transcriptPath = await writeTranscript(currentResult, agent, task, cwd || defaultCwd, startTs, attempt);
    return currentResult;
  } finally {
    if (tmpPromptDir) {
      await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * A child session is worth keeping only while its run keeps failing: on success
 * it is deleted, on failure it stays as forensics until the retention sweep.
 */
async function removeChildSession(id: string): Promise<void> {
  try {
    const files = await fs.promises.readdir(CHILD_SESSION_DIR);
    await Promise.all(
      files
        .filter((f) => f.includes(`_${id}.jsonl`))
        .map((f) => fs.promises.rm(path.join(CHILD_SESSION_DIR, f), { force: true }).catch(() => {})),
    );
  } catch {
    // directory absent — nothing to clean
  }
}

let childSessionsSwept = false;

/** Retention sweep, once per process: sessions of failed runs accumulate otherwise. */
async function sweepChildSessions(): Promise<void> {
  if (childSessionsSwept) return;
  childSessionsSwept = true;
  try {
    const days = getSettings().historyRetentionDays ?? 30;
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    const files = await fs.promises.readdir(CHILD_SESSION_DIR);
    await Promise.all(
      files.map(async (f) => {
        const full = path.join(CHILD_SESSION_DIR, f);
        const st = await fs.promises.stat(full).catch(() => undefined);
        if (st && st.mtimeMs < cutoff) await fs.promises.rm(full, { force: true }).catch(() => {});
      }),
    );
  } catch {
    // no directory yet
  }
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
  const maxAttempts = 1 + SPAWN_RETRY_EXTRA;
  void sweepChildSessions();

  let session: ChildSession = { id: makeChildSessionId(agentName), dir: CHILD_SESSION_DIR };
  /** Attempt 2+ resumes the child's own conversation instead of restarting it. */
  let resume = false;
  /** One fresh-session attempt per run, for a resumed history the provider rejects. */
  let freshFallbackUsed = false;

  let result = await runSingleAgentOnce(
    defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, 1, undefined, session,
  );

  for (let attempt = 2; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) break;
    const text = `${result.errorMessage ?? ""} ${result.stderr ?? ""}`;
    // A resumed child can fail on its own broken tail — a tool call whose stream
    // died before the result earns a provider 400. One fresh attempt recovers
    // that; quota/auth never qualify, so a dead key costs no extra spawn.
    const freshRetry = resume && !freshFallbackUsed && isPayloadRejectionError(text);
    if (!freshRetry && !shouldRetrySpawn(result)) break;
    if (freshRetry) {
      freshFallbackUsed = true;
      session = { id: makeChildSessionId(agentName), dir: CHILD_SESSION_DIR };
      resume = false;
    }
    const delayMs = delayForAttempt(RESPAWN_DELAYS_MS, attempt - 1);
    await logger.warn(
      freshRetry ? "Respawning subagent with a fresh session after a payload rejection" : "Resuming subagent after transient provider error",
      { agent: agentName, attempt, maxAttempts, delayMs, session: session.id, resume, error: result.errorMessage },
      defaultCwd,
    );
    const waited = await sleepAbortable(delayMs, signal);
    if (!waited) return result;
    const prompt = resume ? buildResumePrompt(result.errorMessage, attempt) : task;
    result = await runSingleAgentOnce(
      defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, attempt, prompt, session,
    );
    resume = true;
  }

  // Success closes the loop: the child session has no further use.
  if (!isFailedResult(result)) await removeChildSession(session.id);
  return result;
}
