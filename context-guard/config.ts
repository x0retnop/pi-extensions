import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ContextNoticesSettings, GuardSettings } from "./types.js";
import { DEFAULT_CONTEXT_NOTICES } from "./types.js";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "contextGuard";

export function loadSettingsFile(): any {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveSettingsFile(settings: any): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {}
}

function loadContextNotices(raw: any): ContextNoticesSettings {
  const cn = raw?.contextNotices;
  if (typeof cn !== "object" || cn === null) {
    return { ...DEFAULT_CONTEXT_NOTICES };
  }
  return {
    enabled: cn.enabled === true,
    notice60: cn.notice60 !== false,
    notice70: cn.notice70 !== false,
  };
}

export function loadGuardSettings(): GuardSettings {
  const settings = loadSettingsFile();
  const raw = settings[SETTINGS_KEY] ?? {};
  return {
    features: typeof raw.features === "object" && raw.features !== null ? raw.features : {},
    promptRules: typeof raw.promptRules === "object" && raw.promptRules !== null ? raw.promptRules : {},
    autoSkills: raw.autoSkills !== false,
    agentsInject: raw.agentsInject !== false,
    contextNotices: loadContextNotices(raw),
  };
}

export function saveGuardSettings(guard: GuardSettings): void {
  const settings = loadSettingsFile();
  settings[SETTINGS_KEY] = guard;
  saveSettingsFile(settings);
}

export interface ShellSettings {
  shellPath: string | undefined;
  shellCommandPrefix: string | undefined;
}

export function loadShellSettings(): ShellSettings {
  const settings = loadSettingsFile();
  return {
    shellPath: typeof settings.shellPath === "string" && settings.shellPath.trim() !== "" ? settings.shellPath : undefined,
    shellCommandPrefix: typeof settings.shellCommandPrefix === "string" && settings.shellCommandPrefix.trim() !== "" ? settings.shellCommandPrefix : undefined,
  };
}
