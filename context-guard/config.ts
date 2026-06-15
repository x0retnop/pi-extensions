import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GuardSettings } from "./types.js";

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

export function loadGuardSettings(): GuardSettings {
  const settings = loadSettingsFile();
  const raw = settings[SETTINGS_KEY] ?? {};
  return {
    features: typeof raw.features === "object" && raw.features !== null ? raw.features : {},
    promptRules: typeof raw.promptRules === "object" && raw.promptRules !== null ? raw.promptRules : {},
    autoSkills: raw.autoSkills !== false,
  };
}

export function saveGuardSettings(guard: GuardSettings): void {
  const settings = loadSettingsFile();
  settings[SETTINGS_KEY] = guard;
  saveSettingsFile(settings);
}
