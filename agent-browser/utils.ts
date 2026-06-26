import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBrowserResult } from "./types.js";

const AGENT_BROWSER_BIN = "agent-browser";
const DEFAULT_TIMEOUT_MS = 60_000;
const KILL_DELAY_MS = 5_000;

function forceKill(child: ChildProcess): void {
  if (!child || child.killed) return;
  try {
    if (platform() === "win32" && child.pid) {
      // On Windows SIGTERM is unreliable for .exe processes; use taskkill.
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        windowsHide: true,
        detached: true,
      });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, KILL_DELAY_MS);
    }
  } catch {
    // Ignore cleanup errors.
  }
}

function findWindowsExe(): string {
  // 1. Look alongside this module under node_modules/agent-browser/bin
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(here, "..", "..", "..", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
    if (existsSync(candidate)) return candidate;
  } catch {}

  // 2. Look under the npm global root.
  try {
    const globalRoot = process.env.npm_config_prefix || process.env.ProgramFiles;
    if (globalRoot) {
      const candidate = join(globalRoot, "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
      if (existsSync(candidate)) return candidate;
    }
  } catch {}

  // 3. Common global locations.
  const commonPaths = [
    join(process.env.LOCALAPPDATA || "", "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe"),
    join(process.env.APPDATA || "", "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe"),
    "C:\\Program Files\\nodejs\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe",
    "C:\\Program Files (x86)\\nodejs\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe",
  ];
  for (const p of commonPaths) {
    if (p && existsSync(p)) return p;
  }

  return AGENT_BROWSER_BIN;
}

function getAgentBrowserBin(): string {
  if (platform() !== "win32") return AGENT_BROWSER_BIN;
  return findWindowsExe();
}

export const AGENT_BROWSER_PATH = getAgentBrowserBin();

export async function runAgentBrowser(
  args: string[],
  session?: string,
  cdpUrl?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AgentBrowserResult> {
  const fullArgs: string[] = [];
  if (cdpUrl) fullArgs.push("--cdp", cdpUrl);
  if (session) fullArgs.push("--session", session);
  fullArgs.push(...args, "--json");

  return new Promise((resolve) => {
    const child = spawn(AGENT_BROWSER_PATH, fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      stdout += "\n[TIMEOUT: agent-browser did not finish within timeout; forcing termination]";
      forceKill(child);
      forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, KILL_DELAY_MS + 1_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        ok: false,
        output: "",
        error: `Failed to start agent-browser: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const combined = stdout || stderr;
      if (!combined.trim()) {
        resolve({
          ok: code === 0,
          output: "",
          error: code === 0 ? undefined : `agent-browser exited with code ${code}`,
        });
        return;
      }

      let parsed: { success?: boolean; data?: unknown; error?: string } | undefined;
      try {
        parsed = JSON.parse(combined) as typeof parsed;
      } catch {
        // Not JSON — return raw text.
        resolve({ ok: code === 0, output: combined.trim(), error: stderr || undefined });
        return;
      }

      if (parsed && typeof parsed === "object") {
        if (parsed.success === true) {
          resolve({ ok: true, output: formatJsonData(parsed.data) });
        } else {
          resolve({
            ok: false,
            output: "",
            error: typeof parsed.error === "string" ? parsed.error : "agent-browser error",
          });
        }
      } else {
        resolve({ ok: code === 0, output: combined.trim(), error: stderr || undefined });
      }
    });
  });
}

function formatJsonData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (typeof data === "object" && "snapshot" in (data as Record<string, unknown>)) {
    return String((data as Record<string, unknown>).snapshot ?? "");
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function parseWaitOption(wait: string | undefined): string[] {
  if (!wait) return [];
  const trimmed = wait.trim();
  if (!trimmed) return [];

  // Numeric milliseconds.
  if (/^\d+$/.test(trimmed)) return ["wait", trimmed];

  // JS function / expression.
  if (trimmed.startsWith("function") || trimmed.includes("return") || trimmed.includes("window.")) {
    return ["wait", "--fn", trimmed];
  }

  // URL glob pattern.
  if (trimmed.includes("/") || trimmed.includes("*")) {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.includes("*")) {
      return ["wait", "--url", trimmed];
    }
  }

  // Load state.
  if (["networkidle", "domcontentloaded", "load"].includes(trimmed)) {
    return ["wait", "--load", trimmed];
  }

  // Looks like a selector or ref.
  if (trimmed.startsWith("@") || trimmed.startsWith("#") || trimmed.startsWith(".") || trimmed.includes(" ")) {
    return ["wait", trimmed];
  }

  // Default: wait for text.
  return ["wait", "--text", trimmed];
}

export function sanitizeSelector(sel: string): string {
  return sel.trim();
}

export function extraArgsToStrings(extraArgs: unknown): string[] {
  if (!Array.isArray(extraArgs)) return [];
  return extraArgs.filter((x): x is string => typeof x === "string");
}

export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export function truncateOutput(
  text: string,
  maxChars: number = DEFAULT_MAX_OUTPUT_CHARS,
  hint?: string,
): string {
  if (!text || text.length <= maxChars) return text;
  const hidden = text.length - maxChars;
  const suffix = hint
    ? `\n[TRUNCATED: ${hidden.toLocaleString()} characters hidden; ${hint}]`
    : `\n[TRUNCATED: ${hidden.toLocaleString()} characters hidden]`;
  const keep = Math.max(0, maxChars - suffix.length);
  return text.slice(0, keep) + suffix;
}

export function truncateLines(text: string, maxLines: number): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n[TRUNCATED: ${lines.length - maxLines} more lines hidden]`
  );
}

interface NetworkRequestEntry {
  method?: unknown;
  url?: unknown;
  status?: unknown;
  resourceType?: unknown;
  mimeType?: unknown;
  timestamp?: unknown;
}

export function summarizeNetworkRequests(
  output: string,
  maxItems = 50,
  full = false,
): string {
  if (full) return truncateOutput(output, DEFAULT_MAX_OUTPUT_CHARS, "use full:false for summary");

  let parsed: { requests?: NetworkRequestEntry[] } | undefined;
  try {
    parsed = JSON.parse(output) as { requests?: NetworkRequestEntry[] };
  } catch {
    return truncateOutput(output, DEFAULT_MAX_OUTPUT_CHARS);
  }

  const requests = Array.isArray(parsed?.requests) ? parsed.requests : [];
  const total = requests.length;
  const slice = requests.slice(0, maxItems).map((r) => ({
    method: r.method,
    url: r.url,
    status: r.status,
    resourceType: r.resourceType,
    mimeType: r.mimeType,
    timestamp: r.timestamp,
  }));

  const summary = {
    total,
    shown: slice.length,
    truncated: total > maxItems ? total - maxItems : 0,
    hint: "Use full:true or pattern:<glob> to see more details or headers.",
    requests: slice,
  };

  return JSON.stringify(summary, null, 2);
}
