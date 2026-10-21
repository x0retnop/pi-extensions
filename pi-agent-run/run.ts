import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../common/duration.js";
import { cleanupOutputPath, guardOutput } from "./output-guard.js";

const POST_EXIT_IDLE_GRACE_MS = 100;

export const MAX_TIMEOUT_MS = 3_600_000; // 1 hour
export const DEFAULT_TIMEOUT_SEC = 120;

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  input?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface RunToolDetails {
  exitCode: number | null;
  timedOut: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
}

/** Spill paths from this session; drained on the next session_start. */
const spillPaths = new Set<string>();

export function trackSpillPath(filePath: string | undefined): void {
  if (filePath) spillPaths.add(filePath);
}

export async function drainSpillPaths(): Promise<void> {
  const paths = [...spillPaths];
  spillPaths.clear();
  await Promise.all(paths.map((p) => cleanupOutputPath(p)));
}

export function resolveTimeoutMs(timeoutSec?: number): number | undefined {
  if (timeoutSec === 0) return undefined;
  const effectiveTimeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isFinite(effectiveTimeout) || effectiveTimeout < 0) {
    throw new Error(
      "Invalid timeout: must be a finite non-negative number of seconds (0 disables timeout)",
    );
  }
  const ms = effectiveTimeout * 1000;
  if (ms > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: maximum is ${Math.floor(MAX_TIMEOUT_MS / 1000)} seconds`,
    );
  }
  return ms;
}

export function getAgentProfilePath(): string {
  return path.join(getAgentDir(), "profile.ps1");
}

export function encodePwshCommand(code: string, profilePath = getAgentProfilePath()): string {
  // PowerShell expects Base64 encoded UTF-16 LE for -EncodedCommand.
  // Bootstrap the agent profile first so every pwsh tool gets UTF-8, PATH,
  // and Linux-reflex aliases in a non-interactive-safe way.
  const escaped = profilePath.replace(/'/g, "''");
  const bootstrap =
    `if (Test-Path -LiteralPath '${escaped}') { . '${escaped}' }; ` + code;
  return Buffer.from(bootstrap, "utf16le").toString("base64");
}

/**
 * Kill a process and its descendants. On Windows this uses taskkill so that
 * grandchildren (e.g. a `node` process spawned from inside `pwsh`) are also
 * terminated and cannot keep inherited stdio pipes open forever.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null || child.killed) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // Process may already be gone; ignore taskkill failures.
    }
  } else {
    child.kill("SIGTERM");
    setTimeout(() => {
      // `killed` only tracks whether a signal was sent, not whether the process
      // actually exited, so check the live state before escalating to SIGKILL.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
  }
}

export function runCommand(
  program: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Command cancelled"));
      return;
    }

    const child = spawn(program, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let idleHandle: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    let settled = false;
    let exited = false;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    let exitCode: number | null = null;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (idleHandle) clearTimeout(idleHandle);
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      child.stdout?.removeAllListeners("data");
      child.stdout?.removeAllListeners("end");
      child.stderr?.removeAllListeners("data");
      child.stderr?.removeAllListeners("end");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      child.removeAllListeners("close");
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code, stdout, stderr, timedOut });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = () => {
      if (idleHandle) clearTimeout(idleHandle);
      idleHandle = setTimeout(() => finalize(exitCode), POST_EXIT_IDLE_GRACE_MS);
    };

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (exited && !settled) armIdleTimer();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (exited && !settled) armIdleTimer();
    });

    child.stdout?.on("end", () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    });
    child.stderr?.on("end", () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    });

    child.on("error", (err) => fail(err));

    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    });

    child.on("close", (code) => finalize(code));

    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, options.timeoutMs);
    }

    abortHandler = () => {
      killProcessTree(child);
      fail(new Error("Command cancelled"));
    };
    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    if (options.input !== undefined) {
      child.stdin?.write(options.input, "utf-8", () => {
        child.stdin?.end();
      });
    } else {
      child.stdin?.end();
    }
  });
}

/** Model-visible exit line. `details.exitCode` is not sent to the model. */
function withExit(text: string, exitCode: number | null): string {
  if (exitCode === null) return text;
  return `${text}\nexit: ${exitCode}`;
}

export async function formatResult(
  result: RunResult,
  maxOutputBytes: number | undefined,
  timeoutSec?: number,
  failOnError = true,
  expectedExitCodes?: number[],
): Promise<AgentToolResult<RunToolDetails>> {
  const rawOutput = (
    result.stdout + (result.stderr ? "\n" + result.stderr : "")
  ).trim();

  const guarded = await guardOutput(rawOutput, {
    maxBytes: maxOutputBytes,
    tempFilePrefix: result.timedOut ? "pi-agent-run-timeout" : "pi-agent-run",
  });
  trackSpillPath(guarded.details.fullOutputPath);

  if (result.timedOut) {
    // Same wording as the native shell tools (host patch P-10): minutes, not seconds.
    const notice = timeoutSec !== undefined
      ? `Command timed out after ${formatDuration(timeoutSec * 1000)}`
      : "Command timed out";
    throw new Error(
      withExit(guarded.text ? `${guarded.text}\n\n${notice}` : notice, result.exitCode),
    );
  }

  const isExpected = result.exitCode !== null &&
    (result.exitCode === 0 || (expectedExitCodes?.includes(result.exitCode) ?? false));
  if (failOnError && !isExpected) {
    throw new Error(
      withExit(
        guarded.text
          ? `${guarded.text}\n\nCommand exited with code ${result.exitCode ?? "unknown"}`
          : `Command exited with code ${result.exitCode ?? "unknown"}`,
        result.exitCode,
      ),
    );
  }

  return {
    content: [{ type: "text" as const, text: withExit(guarded.text || "(no output)", result.exitCode) }],
    details: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: guarded.details.truncated,
      fullOutputPath: guarded.details.fullOutputPath,
    },
  };
}
