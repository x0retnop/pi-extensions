import { spawn } from "node:child_process";
import type { AgentBrowserResult } from "./types.js";

const AGENT_BROWSER_BIN = "agent-browser";
const DEFAULT_TIMEOUT_MS = 60_000;

export async function runAgentBrowser(
  args: string[],
  session?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AgentBrowserResult> {
  const fullArgs: string[] = [];
  if (session) fullArgs.push("--session", session);
  fullArgs.push(...args, "--json");

  return new Promise((resolve) => {
    const child = spawn(AGENT_BROWSER_BIN, fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output: "",
        error: `Failed to start agent-browser: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
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
