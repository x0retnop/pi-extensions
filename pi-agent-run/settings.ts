import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type HighlightMode = "auto" | "powershell" | "python" | "none";

export interface ToolSettings {
  previewLines: number;
  highlight: boolean;
  highlightMode: HighlightMode;
}

export interface AgentRunSettings {
  pwsh: ToolSettings;
  py: ToolSettings;
}

const DEFAULT_SETTINGS: AgentRunSettings = {
  pwsh: {
    previewLines: 8,
    highlight: true,
    highlightMode: "powershell",
  },
  py: {
    previewLines: 8,
    highlight: true,
    highlightMode: "python",
  },
};

function getSettingsPath(): string {
  // Extension folder is next to this module.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "settings.json");
}

export function clampPreviewLines(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  if (value > 50) return 50;
  return Math.floor(value);
}

export function normalizeMode(value: unknown): HighlightMode {
  if (
    value === "auto" ||
    value === "powershell" ||
    value === "python" ||
    value === "none"
  ) {
    return value;
  }
  return "auto";
}

function mergeToolSettings(
  defaults: ToolSettings,
  incoming: unknown,
): ToolSettings {
  const partial = typeof incoming === "object" && incoming !== null
    ? (incoming as Record<string, unknown>)
    : {};
  return {
    previewLines: clampPreviewLines(
      typeof partial.previewLines === "number"
        ? partial.previewLines
        : defaults.previewLines,
    ),
    highlight: typeof partial.highlight === "boolean"
      ? partial.highlight
      : defaults.highlight,
    highlightMode: normalizeMode(
      partial.highlightMode ?? defaults.highlightMode,
    ),
  };
}

export function loadSettings(): AgentRunSettings {
  const settingsPath = getSettingsPath();
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_SETTINGS;
    }
    const record = parsed as Record<string, unknown>;
    return {
      pwsh: mergeToolSettings(DEFAULT_SETTINGS.pwsh, record.pwsh),
      py: mergeToolSettings(DEFAULT_SETTINGS.py, record.py),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Create a mutable settings object for runtime use. Updates via updateSettings() are reflected immediately.
 */
export function createRuntimeSettings(): AgentRunSettings {
  return JSON.parse(JSON.stringify(loadSettings())) as AgentRunSettings;
}

export function saveSettings(settings: AgentRunSettings): void {
  const settingsPath = getSettingsPath();
  const normalized: AgentRunSettings = {
    pwsh: mergeToolSettings(DEFAULT_SETTINGS.pwsh, settings.pwsh),
    py: mergeToolSettings(DEFAULT_SETTINGS.py, settings.py),
  };
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(normalized, null, 2) + "\n",
    "utf-8",
  );
}

export function updateSettings(
  current: AgentRunSettings,
  tool: "pwsh" | "py",
  patch: Partial<ToolSettings>,
): AgentRunSettings {
  // Mutate in place so live callers holding this object (e.g. renderCall closures) see changes immediately.
  Object.assign(
    current[tool],
    mergeToolSettings(DEFAULT_SETTINGS[tool], {
      ...current[tool],
      ...patch,
    }),
  );
  saveSettings(current);
  return current;
}
