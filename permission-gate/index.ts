// @ts-nocheck

import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { GateMode } from "./types.js";
import {
  decide,
  decideBash,
  askAllowOnceOrSession,
  askReadAccess,
  askTwice,
  normalizeCommand,
} from "./engine.js";
import {
  classifyPathAccess,
  extractFilePath,
  cwdIsTooBroad,
  isInside,
} from "./path-guard.js";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

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

function loadMode(): GateMode {
  const settings = loadSettings();
  const mode = settings.permissionGate?.mode;
  if (mode && ["strict", "balanced", "relaxed", "yolo"].includes(mode)) {
    return mode;
  }
  return "relaxed";
}

function saveMode(mode: GateMode): void {
  const settings = loadSettings();
  settings.permissionGate = { ...(settings.permissionGate || {}), mode };
  saveSettings(settings);
}

let CONFIG = { mode: loadMode() };

const sessionAllowedCommands = new Set<string>();
const sessionAllowedReadRoots = new Set<string>();

function showStatus(ctx: any) {
  if (ctx?.ui?.setStatus) {
    ctx.ui.setStatus("gate", `        gate-mode: ${CONFIG.mode.toUpperCase()}`);
  }
}

export default function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionAllowedCommands.clear();
    sessionAllowedReadRoots.clear();
    showStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    sessionAllowedCommands.clear();
    sessionAllowedReadRoots.clear();
  });

  const MODES: GateMode[] = ["strict", "balanced", "relaxed", "yolo"];

  pi.registerCommand("gate-mode", {
    description: "Set or cycle permission gate mode: strict | balanced | relaxed | yolo",
    handler: async (args: string, ctx: any) => {
      const mode = args.trim().toLowerCase();

      if (!mode) {
        // Cycle to next mode
        const currentIndex = MODES.indexOf(CONFIG.mode);
        const nextMode = MODES[(currentIndex + 1) % MODES.length];
        CONFIG.mode = nextMode;
        saveMode(CONFIG.mode);
        showStatus(ctx);
        ctx.ui.notify?.(`Permission gate mode cycled to: ${CONFIG.mode.toUpperCase()}`, "success");
        return;
      }

      if (!MODES.includes(mode as GateMode)) {
        ctx.ui.notify?.(`Invalid mode: ${mode}. Use: strict | balanced | relaxed | yolo`, "error");
        return;
      }

      CONFIG.mode = mode as GateMode;
      saveMode(CONFIG.mode);
      showStatus(ctx);
      ctx.ui.notify?.(`Permission gate mode set to: ${CONFIG.mode.toUpperCase()}`, "success");
    },
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const cwd = String(ctx?.cwd || process.cwd());
    const tool = String(event.toolName ?? "");
    const input = event.input ?? {};

    // Global CWD guard
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

      const access = classifyPathAccess(filePath, cwd);

      if (access.scope === "inside_project") {
        return undefined;
      }

      const normalizedPath = join(cwd, filePath).toLowerCase();
      for (const root of sessionAllowedReadRoots) {
        if (isInside(normalizedPath, root)) return undefined;
      }

      if ((CONFIG.mode === "relaxed" || CONFIG.mode === "yolo") && access.scope === "outside_project") {
        return undefined;
      }

      const decision = await askReadAccess(
        ctx,
        `Read file outside current project?\n\nPath: ${filePath}\nReason: ${access.reason}`
      );

      if (decision === "directory") {
        sessionAllowedReadRoots.add(dirname(normalizedPath));
        return undefined;
      }
      if (decision !== "once") {
        return {
          block: true,
          reason: `User denied read outside current project:\n${filePath}`,
        };
      }
      return undefined;
    }

    // ─── WRITE / EDIT ───
    if (tool === "write" || tool === "edit") {
      const filePath = extractFilePath(input);
      if (!filePath) return undefined;

      const access = classifyPathAccess(filePath, cwd);
      if (access.scope === "inside_project") {
        return undefined;
      }

      const allowed = await askTwice(
        ctx,
        `${tool.toUpperCase()} file outside current project?\n\n` +
        `Path: ${filePath}\n` +
        `Reason: ${access.reason}\n\n` +
        `This may modify files outside the active project.`
      );

      if (!allowed) {
        return {
          block: true,
          reason: `User denied ${tool} outside current project:\n${filePath}`,
        };
      }
      return undefined;
    }

    // ─── BASH ───
    if (tool === "bash") {
      const command = String(input.command ?? "").trim();
      if (!command) return undefined;

      const decision = decideBash(command, CONFIG.mode, sessionAllowedCommands, cwd);

      if (decision.action === "block") {
        return {
          block: true,
          reason: `Blocked by permission-gate:\n${command}\n${decision.reason}`,
        };
      }

      if (decision.action === "allow") {
        return undefined;
      }

      // Ask user
      const choice = await askAllowOnceOrSession(
        ctx,
        `Allow command?\n${decision.reason}\n\n${command}`
      );

      if (choice === "command") {
        sessionAllowedCommands.add(normalizeCommand(command));
        return undefined;
      }
      if (choice === "once") {
        return undefined;
      }
      return {
        block: true,
        reason: `User denied command:\n${command}`,
      };
    }

    return undefined;
  });
}
