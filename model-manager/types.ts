import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FavoriteItem {
  providerId: string;
  modelId?: string;
}

export interface CachedModel {
  id: string;
  name: string;
  api: Api;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

export interface ModelOverride {
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  costInput?: number;
  costOutput?: number;
}

export interface ManagedProvider {
  id: string;
  enabled: boolean;
  useLatestDefault: boolean;
  lastUsedModel?: string;
  managedModelIds: string[];
  overrides?: Record<string, ModelOverride>;
  // Cached full model definitions for models fetched from APIs (e.g. OpenRouter).
  cachedModels?: CachedModel[];
  // Only used for custom providers added through the manager.
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
}

export interface GlobalSettings {
  defaultProvider?: string;
  rememberLastUsed: boolean;
  displaySpecs: boolean;
  hiddenProviderIds: string[];
}

export interface ModelManagerConfig {
  version: number;
  providers: ManagedProvider[];
  favorites: FavoriteItem[];
  global: GlobalSettings;
}

export interface ManagerState {
  config: ModelManagerConfig;
  ctx: ExtensionContext | ExtensionCommandContext;
}

export interface ProviderView {
  id: string;
  name: string;
  isBuiltIn: boolean;
  authConfigured: boolean;
  models: Model<Api>[];
  managed: ManagedProvider;
  hidden: boolean;
}

export type UiAction =
  | { type: "close" }
  | { type: "provider"; providerId: string }
  | { type: "useModel"; providerId: string; modelId: string }
  | { type: "settings" }
  | { type: "openrouter" }
  | { type: "addProvider" }
  | { type: "refresh" }
  | { type: "help" }
  | { type: "toggleHidden"; providerId: string }
  | { type: "persist" };
