import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import type { ManagedProvider, ModelManagerConfig } from "./types.js";

const CONFIG_VERSION = 1;
const CONFIG_FILE = "model-manager.json";

export function getConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_FILE);
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
    },
  };
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
        defaultProvider: parsed.global?.defaultProvider,
        hiddenProviderIds: Array.isArray(parsed.global?.hiddenProviderIds) ? parsed.global.hiddenProviderIds : [],
      },
    };
  } catch (err) {
    console.error(`[model-manager] Failed to load config from ${configPath}: ${err}`);
    return createDefaultConfig();
  }
}

export function saveConfig(config: ModelManagerConfig): void {
  const configPath = getConfigPath();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[model-manager] Failed to save config to ${configPath}: ${err}`);
  }
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
  return {
    id: p.id ?? "unknown",
    enabled: p.enabled ?? true,
    useLatestDefault: p.useLatestDefault ?? true,
    lastUsedModel: p.lastUsedModel,
    managedModelIds: Array.isArray(p.managedModelIds) ? p.managedModelIds : [],
    overrides: p.overrides && typeof p.overrides === "object" ? p.overrides : undefined,
    cachedModels: Array.isArray(p.cachedModels) ? p.cachedModels : undefined,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    api: p.api,
  };
}
