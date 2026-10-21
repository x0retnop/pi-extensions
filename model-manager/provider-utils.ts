import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getModel as getBuiltinModel, getProviders } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.js";
import { fetchOpencodeModels, opencodeModelToCached } from "./opencode.js";
import { fetchOpenRouterModels, openRouterModelToCached } from "./openrouter.js";
import { fetchNanoGptModels, nanoGptModelToCached } from "./nanogpt.js";
import type { CachedModel, ManagedProvider, ModelManagerConfig, ModelOverride, ProviderView } from "./types.js";
import {
  NANOGPT_BASE_URL,
  OPENCODE_GO_BASE_URL,
  OPENROUTER_BASE_URL,
  patchCuratedModelDef,
} from "./wire-compat.js";

export { patchCuratedModelDef, detectModelFamily } from "./wire-compat.js";
export {
  hasModelScope,
  isModelInScope,
  findScopedThinkingLevel,
  describeModelScope,
} from "./scope.js";

const builtInProviders = new Set(getProviders());

export function isBuiltInProvider(providerId: string): boolean {
  return builtInProviders.has(providerId as any);
}

export function isCuratableProvider(providerId: string, managed?: ManagedProvider): boolean {
  // Built-in providers we explicitly support for sync/curation.
  if (providerId === "openrouter" || providerId === "opencode-go") return true;
  if (isBuiltInProvider(providerId)) return false;
  // Custom provider from models.json: only curate if we have its connection
  // details (meaning it was added through this extension's TUI). Otherwise we
  // must not touch it, so provider-level headers/compat from models.json stay
  // intact.
  if (managed) {
    return !!managed.baseUrl && !!managed.apiKey && !!managed.api;
  }
  // Providers from models.json that are not owned by this extension must not
  // be touched, so default to false when we have no managed record.
  return false;
}

export function getProviderModels(registry: ExtensionContext["modelRegistry"], providerId: string): Model<Api>[] {
  return registry.getAll().filter((m) => m.provider === providerId);
}

export function isProviderHidden(config: ModelManagerConfig, providerId: string): boolean {
  return config.global.hiddenProviderIds.includes(providerId);
}

export function getProviderViews(
  ctx: ExtensionContext | ExtensionCommandContext,
  config: ModelManagerConfig,
): ProviderView[] {
  const managed = config.providers;
  const hidden = new Set(config.global.hiddenProviderIds);
  const allModels = ctx.modelRegistry.getAll();
  const byProvider = new Map<string, Model<Api>[]>();
  for (const m of allModels) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  // Include managed providers even if they currently have no registered models.
  for (const p of managed) {
    if (!byProvider.has(p.id)) {
      byProvider.set(p.id, []);
    }
  }
  // Hidden providers with no registry rows must still appear as views:
  // the host P-6b decat blanks unused built-in catalogs, so a hidden provider
  // often registers zero models — without this row the hidden-providers
  // screen would claim "No hidden providers" while the config lists them,
  // making them unrestorable from the TUI.
  for (const id of hidden) {
    if (!byProvider.has(id)) {
      byProvider.set(id, []);
    }
  }
  const views: ProviderView[] = [];
  for (const [id, models] of byProvider) {
    const cfg = managed.find((p) => p.id === id) ?? {
      id,
      enabled: true,
      useLatestDefault: true,
      managedModelIds: [],
    };
    views.push({
      id,
      name: ctx.modelRegistry.getProviderDisplayName(id) || id,
      isBuiltIn: isBuiltInProvider(id),
      authConfigured: ctx.modelRegistry.getProviderAuthStatus(id).configured,
      models,
      managed: cfg,
      hidden: hidden.has(id),
    });
  }
  // Sort: visible providers first, then hidden; within each group built-ins first, then alphabetical.
  views.sort((a, b) => {
    if (!a.hidden && b.hidden) return -1;
    if (a.hidden && !b.hidden) return 1;
    if (a.isBuiltIn && !b.isBuiltIn) return -1;
    if (!a.isBuiltIn && b.isBuiltIn) return 1;
    return a.name.localeCompare(b.name);
  });
  return views;
}

export function getProviderView(
  ctx: ExtensionContext | ExtensionCommandContext,
  config: ModelManagerConfig,
  providerId: string,
): ProviderView | undefined {
  return getProviderViews(ctx, config).find((v) => v.id === providerId);
}

export function getDefaultModelForProvider(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): Model<Api> | undefined {
  const models = getProviderModels(ctx.modelRegistry, providerId);
  if (models.length === 0) return undefined;
  const aliases = models.filter((m) => isAliasModelId(m.id));
  const pool = aliases.length > 0 ? aliases : models;
  // Highest version-looking number in the id wins; id descending is the
  // tie-break. A plain id sort is wrong here: it prefers `grok-build-0.1`
  // (v0.1) over `grok-4.7`, because "grok-b" sorts above "grok-4".
  return [...pool].sort(
    (a, b) => latestVersion(b.id) - latestVersion(a.id) || b.id.localeCompare(a.id),
  )[0];
}

/** First `major[.minor]` number in a model id: `grok-4.7` → 4.7, `grok-build-0.1` → 0.1. */
function latestVersion(id: string): number {
  const match = id.match(/\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : -1;
}

function isAliasModelId(id: string): boolean {
  return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

export function modelToProviderConfig(m: Model<Api> | CachedModel | Record<string, unknown>): any {
  const any = m as any;
  return {
    id: any.id,
    name: any.name,
    api: any.api,
    baseUrl: any.baseUrl,
    reasoning: any.reasoning,
    thinkingLevelMap: any.thinkingLevelMap,
    input: any.input,
    cost: any.cost,
    contextWindow: any.contextWindow,
    maxTokens: any.maxTokens,
    headers: any.headers,
    compat: any.compat,
  };
}

/**
 * Resolve a full model definition for curation.
 *
 * Priority:
 * 1. Pi built-in catalog (has correct api/compat/maxTokens for known models)
 * 2. Live registry entry that still looks "rich" (not a previous bare re-register)
 * 3. Cached sync entry (enriched when possible)
 * 4. Bare defaults with provider-safe compat
 */
export function resolveCuratedModelDef(
  providerId: string,
  modelId: string,
  registry: ExtensionContext["modelRegistry"],
  cachedModels?: CachedModel[],
  override?: ModelOverride,
): any | undefined {
  let def: any | undefined;

  const builtin = getBuiltinModel(providerId as any, modelId);
  if (builtin) {
    def = modelToProviderConfig(builtin);
  } else {
    const live = registry.getAll().find((m) => m.provider === providerId && m.id === modelId);
    if (live && isRichModelMeta(live)) {
      def = modelToProviderConfig(live);
    } else {
      const cached = cachedModels?.find((m) => m.id === modelId);
      if (cached && isRichCachedMeta(cached)) {
        def = cachedModelToProviderConfig(cached);
      } else if (live) {
        def = modelToProviderConfig(live);
      } else if (cached) {
        def = cachedModelToProviderConfig(withProviderDefaults(providerId, cached));
      }
    }
  }

  if (!def) return undefined;
  return patchCuratedModelDef(providerId, def, override);
}

/** True when metadata is unlikely to be the bare sync stub (4096 / no compat). */
function isRichModelMeta(m: Model<Api>): boolean {
  return !!m.compat || m.reasoning === true || m.maxTokens > 8192 || (m.input?.length ?? 0) > 1;
}

function isRichCachedMeta(m: CachedModel): boolean {
  return !!m.compat || m.reasoning === true || m.maxTokens > 8192 || !!m.baseUrl || (m.input?.length ?? 0) > 1;
}

/**
 * Build a CachedModel for persistence after sync.
 * Prefer Pi's built-in catalog; otherwise apply provider-safe defaults on the API stub.
 */
export function enrichCachedModel(
  providerId: string,
  modelId: string,
  fromApi: CachedModel,
  override?: ModelOverride,
): CachedModel {
  let result: CachedModel;
  const builtin = getBuiltinModel(providerId as any, modelId);
  if (builtin) {
    result = {
      id: builtin.id,
      name: builtin.name,
      api: builtin.api,
      baseUrl: builtin.baseUrl,
      reasoning: builtin.reasoning,
      thinkingLevelMap: builtin.thinkingLevelMap,
      input: [...builtin.input] as CachedModel["input"],
      cost: { ...builtin.cost },
      contextWindow: builtin.contextWindow,
      maxTokens: builtin.maxTokens,
      compat: builtin.compat,
    };
  } else {
    result = withProviderDefaults(providerId, fromApi);
  }
  return patchCuratedModelDef(providerId, result, override) as CachedModel;
}

/**
 * Re-enrich curated caches (e.g. after a bare sync stub or catalog fix).
 * Returns true if any provider's cachedModels changed.
 */
export function repairManagedCaches(config: ModelManagerConfig): boolean {
  let changed = false;
  for (const p of config.providers) {
    if (!p.managedModelIds?.length) continue;

    const next = p.managedModelIds.map((id) => {
      const existing = p.cachedModels?.find((c) => c.id === id);
      const stub: CachedModel = existing ?? {
        id,
        name: id,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      };
      return enrichCachedModel(p.id, id, stub);
    });

    if (JSON.stringify(next) !== JSON.stringify(p.cachedModels ?? [])) {
      p.cachedModels = next;
      changed = true;
    }
  }
  return changed;
}

function withProviderDefaults(providerId: string, m: CachedModel): CachedModel {
  // Thin structural defaults only — wire-compat owns family/proxy compat.
  if (providerId === "opencode-go") {
    return {
      ...m,
      baseUrl: m.baseUrl ?? OPENCODE_GO_BASE_URL,
      maxTokens: m.maxTokens > 8192 ? m.maxTokens : 65536,
      contextWindow: m.contextWindow > 32000 ? m.contextWindow : 128000,
    };
  }
  if (providerId === "openrouter") {
    return {
      ...m,
      baseUrl: m.baseUrl ?? OPENROUTER_BASE_URL,
    };
  }
  if (providerId === "nano-gpt") {
    return {
      ...m,
      baseUrl: m.baseUrl ?? NANOGPT_BASE_URL,
    };
  }
  return m;
}

export async function buildCuratedProviderConfig(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
  managed: ManagedProvider,
): Promise<ProviderConfig | undefined> {
  if (managed.managedModelIds.length === 0) return undefined;

  const models = managed.managedModelIds
    .map((id) =>
      resolveCuratedModelDef(providerId, id, ctx.modelRegistry, managed.cachedModels, managed.overrides?.[id]),
    )
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  if (models.length === 0) return undefined;

  // Custom providers store their own connection details.
  if (!isBuiltInProvider(providerId)) {
    if (!managed.baseUrl || !managed.apiKey || !managed.api) return undefined;
    const providerHeaders = models[0]?.headers;
    const displayName = ctx.modelRegistry.getProviderDisplayName(providerId);
    return {
      name: managed.name || displayName || managed.id,
      baseUrl: managed.baseUrl,
      apiKey: managed.apiKey,
      api: managed.api,
      headers: providerHeaders,
      models: models.map(modelToProviderConfig),
      // NanoGPT is added through the TUI (custom provider), so it needs the
      // refresh hook wired here — the built-in branches below have their own.
      ...(providerId === "nano-gpt"
        ? { refreshModels: (refreshCtx: RefreshModelsContext) => refreshCuratedProviderModels("nano-gpt", refreshCtx) }
        : {}),
    };
  }

  if (providerId === "openrouter") {
    const apiKey =
      (await ctx.modelRegistry.getApiKeyForProvider("openrouter")) ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined;
    return {
      name: "OpenRouter",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey,
      api: "openai-completions" as any,
      models: models.map(modelToProviderConfig),
      // Pi calls this on model selector open / `pi update --models` / ModelRegistry.refresh().
      refreshModels: (refreshCtx) => refreshCuratedProviderModels("openrouter", refreshCtx),
    };
  }

  if (providerId === "opencode-go") {
    const apiKey =
      (await ctx.modelRegistry.getApiKeyForProvider("opencode-go")) ?? process.env.OPENCODE_API_KEY;
    if (!apiKey) return undefined;
    // Provider-level defaults; each model may override api/baseUrl (e.g. anthropic-messages).
    return {
      name: "OpenCode Go",
      baseUrl: OPENCODE_GO_BASE_URL,
      apiKey,
      api: "openai-completions" as any,
      models: models.map(modelToProviderConfig),
      refreshModels: (refreshCtx) => refreshCuratedProviderModels("opencode-go", refreshCtx),
    };
  }

  return undefined;
}

// ── Dynamic catalog refresh (ProviderConfig.refreshModels, Pi >= 0.80.8) ──

function apiKeyFromRefreshContext(context: RefreshModelsContext, providerId: string): string | undefined {
  const cred = context.credential;
  if (cred?.type === "api_key" && cred.key) return cred.key;
  if (cred?.type === "oauth" && typeof cred.access === "string" && cred.access) return cred.access;
  if (providerId === "openrouter") return process.env.OPENROUTER_API_KEY;
  if (providerId === "opencode-go") return process.env.OPENCODE_API_KEY;
  if (providerId === "nano-gpt") return process.env.NANOGPT_API_KEY;
  return undefined;
}

/** Offline / fallback: rebuild curated model defs from disk cache + built-in catalog. */
export function curatedModelsFromCache(providerId: string, managed: ManagedProvider): ProviderModelConfig[] {
  return managed.managedModelIds
    .map((id) => {
      const existing = managed.cachedModels?.find((c) => c.id === id);
      const stub: CachedModel = existing ?? {
        id,
        name: id,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      };
      return modelToProviderConfig(enrichCachedModel(providerId, id, stub, managed.overrides?.[id]));
    })
    .filter((m): m is ProviderModelConfig => m !== undefined && !!m.id);
}

/**
 * Pi-invoked refresh for curated OpenRouter / OpenCode Go.
 * Returns only managedModelIds (never the full remote catalog).
 * When network is allowed, re-fetches metadata and persists updated cache.
 */
export async function refreshCuratedProviderModels(
  providerId: string,
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  const cfg = loadConfig();
  const managed = cfg.providers.find((p) => p.id === providerId);
  if (!managed?.enabled || managed.managedModelIds.length === 0) {
    return [];
  }

  if (!context.allowNetwork || context.signal?.aborted) {
    return curatedModelsFromCache(providerId, managed);
  }

  const apiKey = apiKeyFromRefreshContext(context, providerId);
  let fetched: { id: string }[] = [];
  try {
    if (providerId === "openrouter") {
      fetched = await fetchOpenRouterModels(apiKey);
    } else if (providerId === "opencode-go") {
      fetched = await fetchOpencodeModels(apiKey);
    } else if (providerId === "nano-gpt") {
      fetched = await fetchNanoGptModels(apiKey);
    } else {
      return curatedModelsFromCache(providerId, managed);
    }
  } catch {
    // Network blip: keep serving the last good curated list.
    return curatedModelsFromCache(providerId, managed);
  }

  if (context.signal?.aborted) {
    return curatedModelsFromCache(providerId, managed);
  }

  const byId = new Map(fetched.map((m) => [m.id, m]));
  const nextCached: CachedModel[] = managed.managedModelIds.map((id) => {
    const raw = byId.get(id);
    if (raw) {
      const stub =
        providerId === "openrouter"
          ? openRouterModelToCached(raw as any)
          : providerId === "nano-gpt"
            ? nanoGptModelToCached(raw as any)
            : opencodeModelToCached(raw as any);
      return enrichCachedModel(providerId, id, stub);
    }
    const existing = managed.cachedModels?.find((c) => c.id === id);
    const stub: CachedModel = existing ?? {
      id,
      name: id,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
    return enrichCachedModel(providerId, id, stub);
  });

  // Persist fresher metadata so the next cold start is accurate.
  if (JSON.stringify(nextCached) !== JSON.stringify(managed.cachedModels ?? [])) {
    managed.cachedModels = nextCached;
    saveConfig(cfg);
  }

  // Pi replaces the curated model list with whatever we return here, so the
  // manual overrides must be re-applied or a refresh would undo them.
  return nextCached.map((m) =>
    patchCuratedModelDef(providerId, modelToProviderConfig(m), managed.overrides?.[m.id]),
  );
}

function cachedModelToProviderConfig(m: CachedModel): any {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    thinkingLevelMap: m.thinkingLevelMap,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: m.compat,
  };
}

/** Per-process memo: which curated providers we already applied, and their fingerprint. */
export type ApplyMemo = {
  byId: Map<string, string>;
};

export function createApplyMemo(): ApplyMemo {
  return { byId: new Map() };
}

/** Curation identity — lastUsed / favorites / hidden do not change the wire config. */
export function providerCurationFingerprint(p: ManagedProvider): string {
  return JSON.stringify({
    enabled: p.enabled,
    managedModelIds: p.managedModelIds,
    cachedModels: p.cachedModels ?? [],
    // Overrides change the registered defs, so a spec pull must invalidate the memo.
    overrides: p.overrides ?? {},
    name: p.name ?? "",
    baseUrl: p.baseUrl ?? "",
    api: p.api ?? "",
    apiKey: p.apiKey ?? "",
  });
}

export async function applyCuratedRegistrations(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  managed: ManagedProvider[],
  memo: ApplyMemo = createApplyMemo(),
): Promise<ApplyMemo> {
  for (const p of managed) {
    const builtIn = isBuiltInProvider(p.id);
    const curatable = isCuratableProvider(p.id, p);
    const hadCuratedModels = (p.cachedModels?.length ?? 0) > 0 || p.managedModelIds.length > 0;
    const prevFp = memo.byId.get(p.id);
    const already = prevFp !== undefined;

    if (!p.enabled || p.managedModelIds.length === 0) {
      // Drop our override so Pi can restore the built-in / models.json catalog.
      // Skip unregister if we never registered this id — on a fresh ModelRuntime
      // unregister still recomposes + refresh() (not a no-op).
      if (already && (curatable || (builtIn && hadCuratedModels))) {
        try {
          pi.unregisterProvider(p.id);
        } catch {
          // Provider may not have been registered; ignore.
        }
        memo.byId.delete(p.id);
      }
      continue;
    }
    if (!curatable) continue;

    const fp = providerCurationFingerprint(p);
    if (already && prevFp === fp) continue;

    const config = await buildCuratedProviderConfig(ctx, p.id, p);
    if (!config) continue;
    try {
      // Unregister only when replacing a previous apply from this process.
      // First apply on a new ModelRuntime: registerProvider already overrides
      // built-ins (Pi merges defined fields). Unregister+register would fire
      // two refresh() passes per provider.
      if (already) {
        pi.unregisterProvider(p.id);
      }
      pi.registerProvider(p.id, config);
      memo.byId.set(p.id, fp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[model-manager] Failed to register curated provider ${p.id}: ${msg}`, "error");
    }
  }
  return memo;
}
