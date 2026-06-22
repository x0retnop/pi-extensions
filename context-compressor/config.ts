import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CompressorSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "contextCompressor";

export function loadSettingsFile(): any {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveSettingsFile(settings: any): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {
    // ignore
  }
}

export function loadSettings(): CompressorSettings {
  const file = loadSettingsFile();
  const raw = file?.[SETTINGS_KEY] ?? {};
  return {
    enabled: raw.enabled !== false,
    promptName: typeof raw.promptName === "string" && raw.promptName ? raw.promptName : DEFAULT_SETTINGS.promptName,
    mode: raw.mode === "manual" ? "manual" : "auto",
    tokenThresholdPercent: clampNumber(raw.tokenThresholdPercent, DEFAULT_SETTINGS.tokenThresholdPercent, 10, 95),
    stepInterval: clampNumber(raw.stepInterval, DEFAULT_SETTINGS.stepInterval, 1, 1000),
    minMessagesToSummarize: clampNumber(raw.minMessagesToSummarize, DEFAULT_SETTINGS.minMessagesToSummarize, 2, 200),
    maxSummaryTokens: clampNumber(raw.maxSummaryTokens, DEFAULT_SETTINGS.maxSummaryTokens, 200, 8000),
    trimAfterCompress: raw.trimAfterCompress === true,
    keptRecentMessages: clampNumber(raw.keptRecentMessages, DEFAULT_SETTINGS.keptRecentMessages, 2, 100),
    debug: raw.debug === true,
  };
}

export function saveSettings(settings: CompressorSettings): void {
  const file = loadSettingsFile();
  file[SETTINGS_KEY] = settings;
  saveSettingsFile(file);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && !Number.isNaN(value) ? value : fallback;
  return Math.max(min, Math.min(max, num));
}
