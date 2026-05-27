// @ts-nocheck

import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  classifyPathAccess,
  extractFilePath,
  cwdIsTooBroad,
  looksLikePath,
  normalizePath,
} from "./path-guard.js";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

type GateMode = "strict" | "relaxed" | "yolo" | "off";

interface Config {
  mode: GateMode;
  protectedRoots: string[];
  workspaceRoots: string[];
}

function loadSettings(): any {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveSettings(settings: any): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {}
}

function loadConfig(): Config {
  const settings = loadSettings();
  const sg = settings.simpleGate || {};
  return {
    mode: ["strict", "relaxed", "yolo"].includes(sg.mode) ? sg.mode : "relaxed",
    protectedRoots: Array.isArray(sg.protectedRoots)
      ? sg.protectedRoots.map((r: string) => normalizePath(r, process.cwd()).toLowerCase())
      : [],
    workspaceRoots: Array.isArray(sg.workspaceRoots)
      ? sg.workspaceRoots.map((r: string) => normalizePath(r, process.cwd()).toLowerCase())
      : [],
  };
}

function saveMode(mode: GateMode): void {
  if (mode === "off") return;
  const settings = loadSettings();
  settings.simpleGate = { ...(settings.simpleGate || {}), mode };
  saveSettings(settings);
}

let CONFIG = loadConfig();

const sessionAllowedCommands = new Set<string>();
const sessionAllowedReadRoots = new Set<string>();
const sessionAllowedWriteRoots = new Set<string>();

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function showStatus(ctx: any) {
  if (ctx?.ui?.setStatus) {
    const label = CONFIG.mode === "off" ? "OFF" : CONFIG.mode.toUpperCase();
    ctx.ui.setStatus("gate", `        gate-mode: ${label}`);
  }
}

// ─── Helpers: path extraction (shell-only) ───

/** Everything before a heredoc (`<<`). Heredoc bodies are data, not shell syntax. */
function shellOnly(command: string): string {
  return command.split(/<<['"]?[A-Z_][A-Z0-9_]*['"]?/i)[0];
}

function extractQuotedPaths(text: string): string[] {
  const paths: string[] = [];
  const re = /"(.*?)"|'(.*?)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const content = m[1] ?? m[2];
    if (looksLikePath(content)) paths.push(content);
  }
  return paths;
}

function extractTokenPaths(text: string): string[] {
  const paths: string[] = [];
  for (const tok of text.split(/\s+/)) {
    const clean = tok.replace(/^[\s&|;()]+|[\s&|;()]+$/g, "").replace(/^["']|["']$/g, "");
    if (looksLikePath(clean)) paths.push(clean);
  }
  return paths;
}

function extractRedirectTargets(text: string): string[] {
  const targets: string[] = [];
  const re = /[12]?>[>]?\s*([^"'\s&|;|<>()]+|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let t = m[1].trim().replace(/^["']|["']$/g, "");
    if (t && t.toLowerCase() !== "/dev/null" && t.toLowerCase() !== "nul") targets.push(t);
  }
  return targets;
}

function extractBashPaths(command: string): string[] {
  const shell = shellOnly(command);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...extractQuotedPaths(shell), ...extractTokenPaths(shell), ...extractRedirectTargets(shell)]) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

// ─── Risk helpers ───

const WRITE_KEYWORDS = new Set([
  "cp", "copy", "xcopy", "robocopy", "mv", "move", "rename", "ren",
  "rm", "del", "erase", "rmdir", "rd", "touch", "mkdir", "md",
]);

function isWriteLikeCommand(command: string): boolean {
  return WRITE_KEYWORDS.has(command.trim().split(/\s+/)[0].toLowerCase());
}

const DESTRUCTIVE_PATTERNS = [
  /curl\s.+\|\s*sh\b/,
  /\brm\s+-rf\s+\//,
  /\bformat\s+[A-Za-z]:/i,
  /\bdiskpart\b/,
  /\bdd\s+if=.+\s+of=\/dev\/(sd|hd|nvme)/,
];

function isDestructivePattern(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// ─── Decision engine ───

type Decision = { action: "allow" | "ask" | "block"; reason?: string };

function decideBash(command: string, cwd: string): Decision {
  const norm = normalizeCommand(command);
  if (sessionAllowedCommands.has(norm)) return { action: "allow" };

  if (isDestructivePattern(command)) {
    if (CONFIG.mode === "yolo") return { action: "ask", reason: "matches a known destructive pattern" };
    return { action: "block", reason: "matches a known destructive pattern" };
  }

  const paths = extractBashPaths(command);
  const hasOutside = paths.some((p) => classifyPathAccess(p, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots).scope === "outside_project");
  const hasProtected = paths.some((p) => classifyPathAccess(p, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots).scope === "protected");

  if (hasProtected) {
    if (CONFIG.mode === "yolo") return { action: "ask", reason: "touches a protected system path" };
    return { action: "block", reason: "touches a protected system path" };
  }

  if (isWriteLikeCommand(command) && hasOutside) {
    if (CONFIG.mode === "strict") return { action: "block", reason: "would write outside the active project (blocked in strict mode)" };
    return { action: "ask", reason: "may write outside the active project" };
  }

  if (hasOutside && CONFIG.mode === "strict") {
    return { action: "ask", reason: "accesses paths outside the active project (strict mode)" };
  }

  return { action: "allow" };
}

// ─── Prompts ───

function formatBashPrompt(command: string, reason: string): string {
  return `⛔ Confirmation required\n\nCommand:\n  ${command}\n\nReason:\n  ${reason}`;
}

function formatReadPrompt(filePath: string, reason: string): string {
  return `🟢 READ — outside current project\n\nFile:\n  ${filePath}\n\nScope:\n  ${reason}`;
}

function formatWritePrompt(tool: string, filePath: string, reason: string): string {
  return `🟡 WRITE — ${tool.toUpperCase()} outside project\n\nFile:\n  ${filePath}\n\nScope:\n  ${reason}`;
}

// ─── UI helpers ───

async function askAllowOnceOrSession(
  ctx: any,
  message: string
): Promise<"once" | "command" | "block"> {
  if (!ctx?.hasUI) return "block";
  const choice = await ctx.ui.select(message, ["Allow once", "Always allow this command", "Block"]);
  if (choice === "Allow once") return "once";
  if (choice === "Always allow this command") return "command";
  return "block";
}

async function askReadAccess(
  ctx: any,
  message: string
): Promise<"once" | "directory" | "block"> {
  if (!ctx?.hasUI) return "block";
  const choice = await ctx.ui.select(message, ["Allow once", "Allow this directory", "Block"]);
  if (choice === "Allow once") return "once";
  if (choice === "Allow this directory") return "directory";
  return "block";
}

// ─── Main export ───

export default function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionAllowedCommands.clear();
    sessionAllowedReadRoots.clear();
    sessionAllowedWriteRoots.clear();
    CONFIG = loadConfig();
    showStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    sessionAllowedCommands.clear();
    sessionAllowedReadRoots.clear();
    sessionAllowedWriteRoots.clear();
  });

  const MODES: GateMode[] = ["strict", "relaxed", "yolo", "off"];

  pi.registerCommand("gate-mode", {
    description: "Set or cycle permission gate mode: strict | relaxed | yolo",
    handler: async (args: string, ctx: any) => {
      const mode = args.trim().toLowerCase();
      if (!mode) {
        CONFIG.mode = MODES[(MODES.indexOf(CONFIG.mode) + 1) % MODES.length];
        saveMode(CONFIG.mode);
        showStatus(ctx);
        ctx.ui.notify?.(`Gate mode cycled to: ${CONFIG.mode.toUpperCase()}`, "success");
        return;
      }
      if (!MODES.includes(mode as GateMode)) {
        ctx.ui.notify?.(`Invalid mode: ${mode}. Use: strict | relaxed | yolo | off`, "error");
        return;
      }
      CONFIG.mode = mode as GateMode;
      saveMode(CONFIG.mode);
      showStatus(ctx);
      ctx.ui.notify?.(`Gate mode set to: ${CONFIG.mode.toUpperCase()}`, "success");
    },
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const cwd = String(ctx?.cwd || process.cwd());
    const tool = String(event.toolName ?? "");
    const input = event.input ?? {};

    if (CONFIG.mode === "off") return undefined;

    if (cwdIsTooBroad(cwd)) {
      return {
        block: true,
        reason:
          `Blocked: PI is running from a too-broad directory.\n` +
          `Current directory: ${cwd}\n` +
          `Start PI inside a specific project folder instead.`,
      };
    }

    // ─── READ ───
    if (tool === "read") {
      const filePath = extractFilePath(input);
      if (!filePath) return undefined;

      const access = classifyPathAccess(filePath, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots);
      if (access.scope === "inside_project") return undefined;

      const normalizedPath = normalizePath(filePath, cwd).toLowerCase();
      for (const root of sessionAllowedReadRoots) {
        if (normalizedPath.startsWith(root + "\\") || normalizedPath === root) return undefined;
      }

      if (access.scope === "protected") {
        if (CONFIG.mode === "yolo") {
          const decision = await askReadAccess(ctx, formatReadPrompt(filePath, access.reason));
          if (decision === "directory") {
            sessionAllowedReadRoots.add(dirname(normalizedPath));
            return undefined;
          }
          if (decision !== "once") {
            return { block: true, reason: `Declined reading protected path: ${filePath}` };
          }
          return undefined;
        }
        return {
          block: true,
          reason:
            `The user has blocked access to a protected path: ${filePath}\n\n` +
            `Do NOT try to access this location through another tool or script.`,
        };
      }

      if (CONFIG.mode !== "strict") return undefined;

      const decision = await askReadAccess(ctx, formatReadPrompt(filePath, access.reason));
      if (decision === "directory") {
        sessionAllowedReadRoots.add(dirname(normalizedPath));
        return undefined;
      }
      if (decision !== "once") {
        return {
          block: true,
          reason: `The user declined reading a file outside the current project: ${filePath}`,
        };
      }
      return undefined;
    }

    // ─── WRITE / EDIT ───
    if (tool === "write" || tool === "edit") {
      const filePath = extractFilePath(input);
      if (!filePath) return undefined;

      const access = classifyPathAccess(filePath, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots);
      if (access.scope === "inside_project") return undefined;

      const normalizedPath = normalizePath(filePath, cwd).toLowerCase();
      for (const root of sessionAllowedWriteRoots) {
        if (normalizedPath.startsWith(root + "\\") || normalizedPath === root) return undefined;
      }

      if (access.scope === "protected") {
        if (CONFIG.mode === "yolo") {
          const decision = await askReadAccess(ctx, formatWritePrompt(tool, filePath, access.reason));
          if (decision === "directory") {
            sessionAllowedWriteRoots.add(dirname(normalizedPath));
            return undefined;
          }
          if (decision !== "once") {
            return { block: true, reason: `Declined ${tool} to protected path: ${filePath}` };
          }
          return undefined;
        }
        return {
          block: true,
          reason:
            `The user has blocked ${tool} to a protected path: ${filePath}\n\n` +
            `Do NOT attempt workarounds.`,
        };
      }

      if (CONFIG.mode === "strict") {
        return {
          block: true,
          reason: `The user has blocked ${tool} outside the active project in strict mode: ${filePath}`,
        };
      }

      const decision = await askReadAccess(ctx, formatWritePrompt(tool, filePath, access.reason));
      if (decision === "directory") {
        sessionAllowedWriteRoots.add(dirname(normalizedPath));
        return undefined;
      }
      if (decision !== "once") {
        return {
          block: true,
          reason: `The user declined ${tool} outside the current project: ${filePath}`,
        };
      }
      return undefined;
    }

    // ─── BASH ───
    if (tool === "bash") {
      const command = String(input.command ?? "").trim();
      if (!command) return undefined;

      const decision = decideBash(command, cwd);
      if (decision.action === "block") {
        return {
          block: true,
          reason:
            `This command was blocked by the user's permission settings — not by accident.\n\n` +
            `Command:\n  ${command}\n\n` +
            `Why: ${decision.reason}\n\n` +
            `Do NOT attempt a workaround.`,
        };
      }
      if (decision.action === "allow") return undefined;

      const choice = await askAllowOnceOrSession(ctx, formatBashPrompt(command, decision.reason || ""));
      if (choice === "command") {
        sessionAllowedCommands.add(normalizeCommand(command));
        return undefined;
      }
      if (choice === "once") return undefined;
      return {
        block: true,
        reason:
          `The user declined this command:\n  ${command}\n\n` +
          `Reason: ${decision.reason}\n\n` +
          `Do NOT attempt workarounds.`,
      };
    }

    return undefined;
  });
}
