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

// ─── Path extraction for bash ───

function extractQuotedPaths(command: string): string[] {
  const paths: string[] = [];
  const re = /"(.*?)"|'(.*?)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const content = m[1] ?? m[2];
    if (looksLikePath(content)) paths.push(content);
  }
  return paths;
}

function extractTokenPaths(command: string): string[] {
  const paths: string[] = [];
  const tokens = command.split(/\s+/);
  for (const tok of tokens) {
    const clean = tok.replace(/^[\s&|;()]+|[\s&|;()]+$/g, "").replace(/^["']|["']$/g, "");
    if (looksLikePath(clean)) paths.push(clean);
  }
  return paths;
}

function extractRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const re = /[12]?>[>]?\s*([^"'\s&|;|<>()]+|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    let t = m[1].trim().replace(/^["']|["']$/g, "");
    if (t && !isNullTarget(t)) targets.push(t);
  }
  return targets;
}

function isNullTarget(t: string): boolean {
  const lowered = t.toLowerCase();
  return lowered === "/dev/null" || lowered === "nul";
}

function extractOrderedPathCandidates(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...extractQuotedPaths(command), ...extractTokenPaths(command), ...extractRedirectTargets(command)]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// ─── Inline script helpers ───

function extractInlineCode(command: string): string | null {
  const cMatch = command.match(/(?:^|\s)-c\s+(.+)$/is);
  if (cMatch) {
    let code = cMatch[1].trim();
    if ((code.startsWith('"') && code.endsWith('"')) || (code.startsWith("'") && code.endsWith("'"))) {
      code = code.slice(1, -1);
    }
    return code;
  }
  const heredocMatch = command.match(/<<['"]?([A-Z_][A-Z0-9_]*)['"]?[\r\n]+([\s\S]*?)[\r\n]+\1\s*$/is);
  if (heredocMatch) return heredocMatch[2];
  return null;
}

function inlineHasDestructive(code: string): boolean {
  return /\b(os\.remove|os\.unlink|shutil\.rmtree|shutil\.move|fs\.unlink|fs\.rm|fs\.rmdir|\.write\s*\(|open\s*\([^)]*['"][wax+]|pip\s+install|npm\s+install)\b/.test(code);
}

function extractPathsFromInline(command: string): string[] {
  if (!/^\s*(?:python3?|py|node|sh|bash|zsh)\b/.test(command)) return [];
  const code = extractInlineCode(command);
  if (!code) return [];
  const paths: string[] = [];
  const re = /"(.*?)"|'(.*?)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const s = m[1] ?? m[2];
    if (looksLikePath(s)) paths.push(s);
  }
  return paths;
}

// ─── Risk helpers ───

const WRITE_KEYWORDS = new Set([
  "cp", "copy", "xcopy", "robocopy", "mv", "move", "rename", "ren",
  "rm", "del", "erase", "rmdir", "rd", "touch", "mkdir", "md",
]);

function isWriteLikeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0].toLowerCase();
  return WRITE_KEYWORDS.has(first);
}

const DESTRUCTIVE_PATTERNS = [
  /curl\s+.+\|\s*sh\b/,
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
    return { action: "block", reason: "matches a known destructive pattern (e.g., downloading and immediately executing a remote script)" };
  }

  const paths = extractOrderedPathCandidates(command);
  const inlinePaths = extractPathsFromInline(command);
  const allPaths = [...paths, ...inlinePaths];
  const uniquePaths = Array.from(new Set(allPaths));

  let hasProtectedPath = false;
  let hasOutsidePath = false;
  let hasOutsideWrite = false;

  for (const p of uniquePaths) {
    const access = classifyPathAccess(p, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots);
    if (access.scope === "protected") {
      hasProtectedPath = true;
    } else if (access.scope === "outside_project") {
      hasOutsidePath = true;
    }
  }

  const lastPath = allPaths.length > 0 ? allPaths[allPaths.length - 1] : null;
  if (lastPath) {
    const lastAccess = classifyPathAccess(lastPath, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots);
    if (isWriteLikeCommand(command) && lastAccess.scope === "outside_project") {
      hasOutsideWrite = true;
    }
  }

  for (const t of extractRedirectTargets(command)) {
    const access = classifyPathAccess(t, cwd, CONFIG.workspaceRoots, CONFIG.protectedRoots);
    if (access.scope === "protected") hasProtectedPath = true;
    if (access.scope === "outside_project") hasOutsideWrite = true;
  }

  if (inlinePaths.length === 0 && /^\s*(?:python3?|py|node|sh|bash|zsh)\b/.test(command)) {
    const code = extractInlineCode(command);
    if (code && inlineHasDestructive(code)) {
      if (CONFIG.mode === "strict") return { action: "block", reason: "inline script contains destructive operations (blocked in strict mode)" };
      if (CONFIG.mode === "relaxed") return { action: "ask", reason: "inline script contains destructive operations" };
    }
  }

  if (hasProtectedPath) {
    return { action: "block", reason: "touches a protected system path" };
  }

  if (hasOutsideWrite) {
    if (CONFIG.mode === "strict") return { action: "block", reason: "would write outside the active project (blocked in strict mode)" };
    return { action: "ask", reason: "may write outside the active project" };
  }

  if (hasOutsidePath && CONFIG.mode === "strict") {
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
        const currentIndex = MODES.indexOf(CONFIG.mode);
        CONFIG.mode = MODES[(currentIndex + 1) % MODES.length];
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

    if (CONFIG.mode === "off") {
      return undefined;
    }

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
        return {
          block: true,
          reason:
            `The user has blocked access to a protected path: ${filePath}\n\n` +
            `This is an intentional safety setting, not a random obstacle. ` +
            `Do NOT try to access this location through another tool or script. ` +
            `If you genuinely need something here, explain why to the user and wait for instructions.`,
        };
      }

      if (CONFIG.mode !== "strict") {
        return undefined;
      }

      const decision = await askReadAccess(ctx, formatReadPrompt(filePath, access.reason));
      if (decision === "directory") {
        sessionAllowedReadRoots.add(dirname(normalizedPath));
        return undefined;
      }
      if (decision !== "once") {
        return {
          block: true,
          reason:
            `The user declined reading a file outside the current project: ${filePath}\n\n` +
            `Respect this decision. Do NOT attempt to read it via another command, tool, or script. ` +
            `If this file is essential, explain why to the user and ask for direction.`,
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
        return {
          block: true,
          reason:
            `The user has blocked ${tool} to a protected path: ${filePath}\n\n` +
            `This is an intentional safety setting. ` +
            `Do NOT attempt workarounds (python shutil, node fs, PowerShell, registry edits, etc.). ` +
            `Explain to the user why this change is needed and wait for their guidance.`,
        };
      }

      if (CONFIG.mode === "strict") {
        return {
          block: true,
          reason:
            `The user has blocked ${tool} outside the active project in strict mode: ${filePath}\n\n` +
            `This restriction is intentional. ` +
            `Do NOT try to write elsewhere using a different approach or language. ` +
            `If the file truly belongs outside the project, ask the user explicitly.`,
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
          reason:
            `The user declined ${tool} outside the current project: ${filePath}\n\n` +
            `Respect this decision. Do NOT try to write or modify this file through alternative methods. ` +
            `Explain why this change is needed and wait for the user's guidance.`,
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
            `Do NOT attempt a workaround with a different command, script, or interpreter (python, node, PowerShell, etc.). ` +
            `The user will be very unhappy if you try to bypass this. ` +
            `Instead, explain why you need this and wait for the user's guidance.`,
        };
      }
      if (decision.action === "allow") {
        return undefined;
      }

      const choice = await askAllowOnceOrSession(ctx, formatBashPrompt(command, decision.reason || ""));
      if (choice === "command") {
        sessionAllowedCommands.add(normalizeCommand(command));
        return undefined;
      }
      if (choice === "once") {
        return undefined;
      }
      return {
        block: true,
        reason:
          `The user declined this command:\n  ${command}\n\n` +
          `Reason: ${decision.reason}\n\n` +
          `Do NOT attempt workarounds using other commands, scripts, or interpreters. ` +
          `The user explicitly said no. Explain why you needed this and wait for their instructions.`,
      };
    }

    return undefined;
  });
}
