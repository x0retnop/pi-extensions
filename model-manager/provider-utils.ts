import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ManagedProvider, ModelManagerConfig, ProviderView } from "./types.js";

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
  return true;
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
  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }
  const dated = models.filter((m) => !isAliasModelId(m.id));
  if (dated.length > 0) {
    dated.sort((a, b) => b.id.localeCompare(a.id));
    return dated[0];
  }
  return models[0];
}

function isAliasModelId(id: string): boolean {
  return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

export function modelToProviderConfig(m: Model<Api>): any {
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
    headers: m.headers,
    compat: m.compat as any,
  };
}

export function buildCuratedProviderConfig(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
  managed: ManagedProvider,
): ProviderConfig | undefined {
  if (managed.managedModelIds.length === 0) return undefined;

  const allModels = ctx.modelRegistry.getAll().filter((m) => m.provider === providerId);
  const selectedModels = managed.managedModelIds
    .map((id) => allModels.find((m) => m.id === id))
    .filter((m): m is Model<Api> => m !== undefined);

  const cachedById = new Map((managed.cachedModels ?? []).map((m) => [m.id, m]));
  for (const id of managed.managedModelIds) {
    if (!selectedModels.some((m) => m.id === id)) {
      const cached = cachedById.get(id);
      if (cached) selectedModels.push(cachedModelToProviderConfig(cached));
    }
  }

  if (selectedModels.length === 0) return undefined;

  // Custom providers store their own connection details.
  if (!isBuiltInProvider(providerId)) {
    if (!managed.baseUrl || !managed.apiKey || !managed.api) return undefined;
    // Preserve provider-level headers from the original registry models
    // (e.g. custom User-Agent set in models.json).
    const providerHeaders = selectedModels[0]?.headers;
    const displayName = ctx.modelRegistry.getProviderDisplayName(providerId);
    return {
      name: managed.name || displayName || managed.id,
      baseUrl: managed.baseUrl,
      apiKey: managed.apiKey,
      api: managed.api,
      headers: providerHeaders,
      models: selectedModels.map(modelToProviderConfig),
    };
  }

  // For built-in providers we only support OpenRouter and OpenCode Go curation.
  if (providerId === "openrouter") {
    const baseUrl = selectedModels[0]?.baseUrl || "https://openrouter.ai/api/v1";
    const auth = ctx.modelRegistry.authStorage.get("openrouter");
    const apiKey = auth?.type === "api_key" ? auth.key : process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined;
    return {
      name: "OpenRouter",
      baseUrl,
      apiKey,
      api: "openai-completions" as any,
      models: selectedModels.map(modelToProviderConfig),
    };
  }

  if (providerId === "opencode-go") {
    const baseUrl = selectedModels[0]?.baseUrl || "https://opencode.ai/zen/go/v1";
    const auth = ctx.modelRegistry.authStorage.get("opencode-go");
    const apiKey = auth?.type === "api_key" ? auth.key : process.env.OPENCODE_API_KEY;
    if (!apiKey) return undefined;
    return {
      name: "OpenCode Go",
      baseUrl,
      apiKey,
      api: "openai-completions" as any,
      models: selectedModels.map(modelToProviderConfig),
    };
  }

  return undefined;
}

function cachedModelToProviderConfig(m: import("./types.js").CachedModel): any {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

export function applyCuratedRegistrations(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  managed: ManagedProvider[],
): void {
  for (const p of managed) {
    const builtIn = isBuiltInProvider(p.id);
    const curatable = isCuratableProvider(p.id, p);
    const hadCuratedModels = (p.cachedModels?.length ?? 0) > 0;
    if (!p.enabled || p.managedModelIds.length === 0) {
      // For custom providers added through this extension, unregister when they
      // are disabled or have no curated models. For built-in providers an empty
      // curation means "use the built-in as-is", unless we previously curated
      // it (cachedModels is non-empty) — in that case unregister so Pi can
      // restore the built-in.
      if (curatable || (builtIn && hadCuratedModels)) {
        try {
          pi.unregisterProvider(p.id);
        } catch {
          // Provider may not have been registered; ignore.
        }
      }
      continue;
    }
    if (!curatable) continue;
    const config = buildCuratedProviderConfig(ctx, p.id, p);
    if (!config) continue;
    try {
      // Unregister first so we can override built-in providers or refresh a
      // previously registered custom provider, then register the curated config.
      pi.unregisterProvider(p.id);
      pi.registerProvider(p.id, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[model-manager] Failed to register curated provider ${p.id}: ${msg}`, "error");
    }
  }
}

export async function restoreDefaultOrLastUsed(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  managed: ManagedProvider[],
  defaultProvider?: string,
): Promise<void> {
  if (!defaultProvider) return;
  const cfg = managed.find((p) => p.id === defaultProvider);
  if (!cfg) return;

  let target: Model<Api> | undefined;
  if (cfg.useLatestDefault) {
    target = getDefaultModelForProvider(ctx, cfg.id);
  } else if (cfg.lastUsedModel) {
    target = ctx.modelRegistry.find(cfg.id, cfg.lastUsedModel);
  }
  if (!target) {
    target = getDefaultModelForProvider(ctx, cfg.id);
  }
  if (target) {
    await pi.setModel(target);
  }
}
