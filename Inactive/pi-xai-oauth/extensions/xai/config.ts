import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "piXaiOAuthFork";

export type XaiConfig = {
  enabled?: boolean;
};

function loadSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveSettings(settings: Record<string, unknown>): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {}
}

export function loadXaiConfig(): XaiConfig {
  const settings = loadSettings();
  const cfg = (settings[SETTINGS_KEY] as Record<string, unknown> | undefined) || {};
  return {
    enabled: cfg.enabled === true, // default false
  };
}

export function saveXaiConfig(cfg: XaiConfig): void {
  const settings = loadSettings();
  settings[SETTINGS_KEY] = { ...(settings[SETTINGS_KEY] as Record<string, unknown> | undefined), ...cfg };
  saveSettings(settings);
}
