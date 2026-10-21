import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import type { CycleHotkeysPreset, ManagedProvider, ModelManagerConfig, UsageConfig, UsagePinnedWindow, UsageProviderConfig } from "./types.js";

const CONFIG_VERSION = 1;
const CONFIG_FILE = "model-manager.json";
const USAGE_FILE = "model-manager-usage.json";

export function getConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_FILE);
}

export function getUsagePath(): string {
  return path.join(getAgentDir(), USAGE_FILE);
}

export const CYCLE_HOTKEYS_PRESETS: CycleHotkeysPreset[] = [
  "ctrl+f2",
  "f2",
  "ctrl+shift+arrows",
  "disabled",
];

function normalizeCycleHotkeys(raw: unknown): CycleHotkeysPreset {
  if (typeof raw === "string" && CYCLE_HOTKEYS_PRESETS.includes(raw as CycleHotkeysPreset)) {
    return raw as CycleHotkeysPreset;
  }
  return "ctrl+f2";
}

export function createDefaultConfig(): ModelManagerConfig {
  return {
    version: CONFIG_VERSION,
    providers: [],
    favorites: [],
    global: {
      rememberLastUsed: true,
      displaySpecs: true,
      hiddenProviderIds: [],
      cycleHotkeys: "ctrl+f2",
      hideGrokThinking: true,
    },
  };
}

export function createDefaultUsageConfig(): UsageConfig {
  return { providers: [] };
}

export function loadUsageConfig(): UsageConfig {
  const usagePath = getUsagePath();
  if (!fs.existsSync(usagePath)) {
    return createDefaultUsageConfig();
  }
  try {
    const raw = fs.readFileSync(usagePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UsageConfig>;
    return normalizeUsageConfig(parsed) ?? createDefaultUsageConfig();
  } catch (err) {
    console.error(`[model-manager] Failed to load usage config from ${usagePath}: ${err}`);
    return createDefaultUsageConfig();
  }
}

/** @returns true if the file was written successfully */
export function saveUsageConfig(config: UsageConfig): boolean {
  return writeJsonAtomic(getUsagePath(), config);
}

export function loadConfig(): ModelManagerConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return createDefaultConfig();
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelManagerConfig>;
    return {
      version: parsed.version ?? CONFIG_VERSION,
      providers: Array.isArray(parsed.providers) ? parsed.providers.map(normalizeProvider) : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      global: {
        rememberLastUsed: parsed.global?.rememberLastUsed ?? true,
        displaySpecs: parsed.global?.displaySpecs ?? true,
        hiddenProviderIds: Array.isArray(parsed.global?.hiddenProviderIds) ? parsed.global.hiddenProviderIds : [],
        cycleHotkeys: normalizeCycleHotkeys(parsed.global?.cycleHotkeys),
        hideGrokThinking: typeof parsed.global?.hideGrokThinking === "boolean" ? parsed.global.hideGrokThinking : true,
      },
      usage: normalizeUsageConfig(parsed.usage),
    };
  } catch (err) {
    console.error(`[model-manager] Failed to load config from ${configPath}: ${err}`);
    return createDefaultConfig();
  }
}

/** @returns true if the file was written successfully */
export function saveConfig(config: ModelManagerConfig): boolean {
  return writeJsonAtomic(getConfigPath(), config);
}

/**
 * Atomic write: tmp file + rename (copy fallback). Never truncates the target
 * on a partial write. Returns false and logs on failure (never throws).
 */
function writeJsonAtomic(filePath: string, data: unknown): boolean {
  let tmp: string | undefined;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    try {
      fs.renameSync(tmp, filePath);
      tmp = undefined;
    } catch {
      // Fallback for cross-device or Windows lock races.
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
      tmp = undefined;
    }
    return true;
  } catch (err) {
    console.error(`[model-manager] Failed to save config to ${filePath}: ${err}`);
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup failure
      }
    }
    return false;
  }
}

function normalizeUsageConfig(raw: unknown): UsageConfig | undefined {
  const parsed = raw as Partial<UsageConfig> | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return {
    providers: Array.isArray(parsed.providers)
      ? parsed.providers
          .map((p: unknown) => {
            const item = p as Partial<UsageProviderConfig>;
            if (!item.providerId || !item.usageUrl) return undefined;
            return { providerId: String(item.providerId), usageUrl: String(item.usageUrl) };
          })
          .filter((p): p is UsageProviderConfig => p !== undefined)
      : [],
    pinnedWindow: normalizePinnedWindow(parsed.pinnedWindow),
  };
}

function normalizePinnedWindow(raw: unknown): UsagePinnedWindow | undefined {
  const p = raw as Partial<UsagePinnedWindow> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  if (!p.providerId || !p.label) return undefined;
  return { providerId: String(p.providerId), label: String(p.label) };
}

export function getManagedProvider(
  config: ModelManagerConfig,
  providerId: string,
): ManagedProvider {
  const existing = config.providers.find((p) => p.id === providerId);
  if (existing) return existing;
  const created: ManagedProvider = {
    id: providerId,
    enabled: true,
    useLatestDefault: true,
    managedModelIds: [],
  };
  config.providers.push(created);
  return created;
}

function normalizeProvider(raw: unknown): ManagedProvider {
  const p = raw as Partial<ManagedProvider>;
  if (!p.id) {
    console.warn("[model-manager] Provider entry missing id, falling back to 'unknown'");
  }
  return {
    id: p.id ?? "unknown",
    enabled: p.enabled ?? true,
    useLatestDefault: p.useLatestDefault ?? true,
    lastUsedModel: p.lastUsedModel,
    managedModelIds: Array.isArray(p.managedModelIds) ? p.managedModelIds : [],
    overrides: p.overrides && typeof p.overrides === "object" ? p.overrides : undefined,
    specsPulledAt: typeof p.specsPulledAt === "string" ? p.specsPulledAt : undefined,
    cachedModels: Array.isArray(p.cachedModels) ? p.cachedModels : undefined,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    api: p.api,
  };
}
