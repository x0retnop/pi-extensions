// @ts-nocheck

import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GateMode } from "./types.js";
import {
  decide,
  askAllowOnceOrSession,
  normalizeCommand,
} from "./engine.js";

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

function showStatus(ctx: any) {
  if (ctx?.ui?.setStatus) {
    ctx.ui.setStatus("gate", `        gate-mode: ${CONFIG.mode.toUpperCase()}`);
  }
}

export default function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionAllowedCommands.clear();
    showStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    sessionAllowedCommands.clear();
  });

  pi.registerCommand("gate-mode", {
    description: "Set permission gate mode: strict | balanced | relaxed | yolo",
    handler: async (args: string, ctx: any) => {
      const mode = args.trim().toLowerCase();
      if (!mode) {
        ctx.ui.notify?.(`Permission gate mode: ${CONFIG.mode}`, "info");
        return;
      }
      if (!["strict", "balanced", "relaxed", "yolo"].includes(mode)) {
        ctx.ui.notify?.(`Invalid mode: ${mode}. Use: strict | balanced | relaxed | yolo`, "error");
        return;
      }
      CONFIG.mode = mode as GateMode;
      saveMode(CONFIG.mode);
      showStatus(ctx);
      ctx.ui.notify?.(`Permission gate mode set to: ${CONFIG.mode}`, "success");
    },
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const tool = String(event.toolName ?? "");

    if (tool !== "bash") {
      return undefined;
    }

    const command = String(event.input?.command ?? "").trim();

    if (!command) {
      return undefined;
    }

    const decision = decide(command, CONFIG.mode, sessionAllowedCommands);

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
  });
}
