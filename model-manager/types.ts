import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FavoriteItem {
  providerId: string;
  modelId?: string;
}

/**
 * Persisted model definition for curated providers.
 * Prefer full metadata (compat, baseUrl, thinkingLevelMap) — bare sync
 * fallbacks without compat break OpenCode Go (max_completion_tokens 400s).
 */
export interface CachedModel {
  id: string;
  name: string;
  api: Api;
  /** Per-model endpoint override (e.g. anthropic-style models on opencode-go drop `/v1`). */
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: Model<Api>["compat"];
}

export interface ModelOverride {
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  /**
   * models.dev `modalities.input` (may include video/pdf/audio). Display only —
   * Pi's `Model.input` is driven by `input` below.
   */
  inputModalities?: string[];
  /** models.dev `modalities.output`. Display only. */
  outputModalities?: string[];
  /** models.dev knowledge cutoff, e.g. "2025-05". Display only. */
  knowledge?: string;
  /**
   * Real Pi `Model.input`. Without this, a model missing from the catalog keeps
   * the `["text"]` fallback and Pi strips images ("model does not support
   * images") while the row advertises vision.
   */
  input?: ("text" | "image")[];
}

export interface ManagedProvider {
  id: string;
  enabled: boolean;
  useLatestDefault: boolean;
  lastUsedModel?: string;
  managedModelIds: string[];
  /** Manual per-model truth — wins over the built-in catalog. See models-dev.ts. */
  overrides?: Record<string, ModelOverride>;
  /** ISO timestamp of the last manual models.dev spec pull for this provider. */
  specsPulledAt?: string;
  // Cached full model definitions for models fetched from APIs (e.g. OpenRouter).
  cachedModels?: CachedModel[];
  // Only used for custom providers added through the manager.
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
}

export type CycleHotkeysPreset = "ctrl+f2" | "f2" | "ctrl+shift+arrows" | "disabled";

export interface GlobalSettings {
  rememberLastUsed: boolean;
  displaySpecs: boolean;
  hiddenProviderIds: string[];
  cycleHotkeys: CycleHotkeysPreset;
  /** Collapse Grok 4.5+ thinking *summary* in the TUI. Default on. */
  hideGrokThinking: boolean;
}

export interface UsageProviderConfig {
  providerId: string;
  usageUrl: string;
}

export interface UsagePinnedWindow {
  providerId: string;
  label: string;
}

export interface UsageConfig {
  providers: UsageProviderConfig[];
  pinnedWindow?: UsagePinnedWindow;
}

export interface ModelManagerConfig {
  version: number;
  providers: ManagedProvider[];
  favorites: FavoriteItem[];
  global: GlobalSettings;
  usage?: UsageConfig;
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
  | { type: "assignRole"; favorite: FavoriteItem }
  /** Set Pi's startup model (`settings.json`); omitting both ids clears it. */
  | { type: "setDefault"; providerId?: string; modelId?: string }
  | { type: "settings" }
  | { type: "syncProvider"; providerId: string }
  | { type: "addProvider" }
  | { type: "refresh" }
  | { type: "help" }
  | { type: "viewHidden" }
  | { type: "toggleHidden"; providerId: string }
  | { type: "persist" }
  | { type: "usage" };
