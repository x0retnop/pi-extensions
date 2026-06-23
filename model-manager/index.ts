import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import type { ManagedProvider, ModelManagerConfig, UiAction } from "./types.js";
import { loadConfig, saveConfig, getManagedProvider } from "./config.js";
import {
  applyCuratedRegistrations,
  restoreDefaultOrLastUsed,
  getProviderView,
  buildCuratedProviderConfig,
  isBuiltInProvider,
} from "./provider-utils.js";
import { fetchOpenRouterModels, openRouterModelToCached } from "./openrouter.js";
import { fetchOpencodeModels, opencodeModelToCached } from "./opencode.js";
import { MainScreen } from "./ui/main-screen.js";
import { ProviderDetail } from "./ui/provider-detail.js";
import { SettingsScreen } from "./ui/settings-screen.js";
import { ProviderSyncScreen } from "./ui/provider-sync.js";
import { HiddenProvidersScreen } from "./ui/hidden-providers.js";
import { AddProviderScreen, type NewProviderValues } from "./ui/add-provider.js";
import { AddModelScreen, type NewModelValues } from "./ui/add-model.js";
import type { CachedModel } from "./types.js";

const CUSTOM_TYPE = "model-manager-state";

export default function modelManagerExtension(pi: ExtensionAPI) {
  let config = loadConfig();

  const SYNCABLE_PROVIDERS: Record<
    string,
    {
      label: string;
      fetch: (ctx: ExtensionContext | ExtensionCommandContext) => Promise<{ id: string }[]>;
      toCached: (m: any) => CachedModel;
    }
  > = {
    openrouter: {
      label: "OpenRouter",
      fetch: async (ctx) => {
        const auth = ctx.modelRegistry.authStorage.get("openrouter");
        const apiKey = auth?.type === "api_key" ? auth.key : process.env.OPENROUTER_API_KEY;
        return fetchOpenRouterModels(apiKey);
      },
      toCached: openRouterModelToCached,
    },
    "opencode-go": {
      label: "OpenCode Go",
      fetch: async (ctx) => {
        const auth = ctx.modelRegistry.authStorage.get("opencode-go");
        const apiKey = auth?.type === "api_key" ? auth.key : process.env.OPENCODE_API_KEY;
        return fetchOpencodeModels(apiKey);
      },
      toCached: opencodeModelToCached,
    },
  };

  function persist() {
    saveConfig(config);
    // Keep a lightweight marker in the session so state is tied to the branch.
    pi.appendEntry(CUSTOM_TYPE, { updatedAt: Date.now() });
  }

  function apply(ctx: ExtensionContext | ExtensionCommandContext) {
    applyCuratedRegistrations(pi, ctx, config.providers);
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    apply(ctx);
    if (config.global.defaultProvider) {
      await restoreDefaultOrLastUsed(pi, ctx, config.providers, config.global.defaultProvider);
    }

  });

  pi.on("model_select", async (event, ctx) => {
    if (!config.global.rememberLastUsed) return;
    const providerId = event.model.provider;
    const managed = config.providers.find((p) => p.id === providerId);
    if (managed) {
      managed.lastUsedModel = event.model.id;
      persist();
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    apply(ctx);
  });

  function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  pi.registerCommand("mm", {
    description: "Open the model manager TUI (/mm or /model-manager).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notify(ctx, "Model manager requires TUI mode.", "warning");
        return;
      }
      await openModelManager(ctx);
    },
  });

  pi.registerCommand("model-manager", {
    description: "Alias for /mm.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notify(ctx, "Model manager requires TUI mode.", "warning");
        return;
      }
      await openModelManager(ctx);
    },
  });

  async function useModel(ctx: ExtensionContext | ExtensionCommandContext, providerId: string, modelId: string) {
    const model = ctx.modelRegistry.find(providerId, modelId);
    if (!model) {
      notify(ctx, `Model ${providerId}/${modelId} not found`, "error");
      return;
    }
    const success = await pi.setModel(model);
    if (!success) {
      notify(ctx, `No API key configured for ${providerId}`, "warning");
      return;
    }
    const managed = config.providers.find((p) => p.id === providerId);
    if (managed) {
      managed.lastUsedModel = modelId;
    }
    persist();
    notify(ctx, `Using ${model.name} (${providerId}/${modelId})`, "info");
  }

  async function openModelManager(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    config = loadConfig();
    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      let subview: Component | undefined;

      function backToMain() {
        subview = undefined;
        main.refresh(config);
        tui.requestRender();
      }

      function showHelp() {
        notify(ctx, "/mm shortcuts: ↑↓ navigate · Enter open/use · u use default · h hide/unhide provider · * favorite · / filter · s sync (OpenRouter) · g/G top/bottom · ? help · Esc/q close", "info");
      }

      function handleAction(action: UiAction) {
        switch (action.type) {
          case "close":
            done();
            return;
          case "help":
            showHelp();
            return;
          case "refresh":
            config = loadConfig();
            apply(ctx);
            main.refresh(config);
            notify(ctx, "Model manager refreshed", "info");
            return;
          case "persist":
            persist();
            return;
          case "toggleHidden": {
            toggleHiddenProvider(ctx, action.providerId, false);
            return;
          }
          case "settings":
            subview = new SettingsScreen(tui, theme, kb, ctx, config, (updated) => {
              config = updated;
              persist();
              apply(ctx);
              main.refresh(config);
            }, backToMain);
            break;
          case "provider":
            {
              const view = getProviderView(ctx, config, action.providerId);
              if (!view) {
                notify(ctx, `Provider ${action.providerId} not found`, "error");
                return;
              }
              const isCustom = !isBuiltInProvider(action.providerId);
              const syncSource = SYNCABLE_PROVIDERS[action.providerId];
              subview = new ProviderDetail(
                tui,
                theme,
                kb,
                ctx,
                action.providerId,
                config,
                (updated) => {
                  const idx = config.providers.findIndex((p) => p.id === updated.id);
                  if (idx >= 0) {
                    config.providers[idx] = updated;
                  } else {
                    config.providers.push(updated);
                  }
                  persist();
                  apply(ctx);
                  main.refresh(config);
                },
                backToMain,
                syncSource
                  ? () => {
                      subview = new ProviderSyncScreen(
                        tui,
                        theme,
                        kb,
                        ctx,
                        syncSource.label,
                        () => syncSource.fetch(ctx),
                        (selectedIds, models) => {
                          handleSyncProvider(ctx, action.providerId, selectedIds, models);
                          backToMain();
                        },
                        backToMain,
                      );
                      tui.requestRender();
                    }
                  : undefined,
                syncSource?.label,
                isCustom
                  ? () => {
                      subview = new AddModelScreen(
                        tui,
                        theme,
                        kb,
                        ctx,
                        action.providerId,
                        (values) => {
                          handleAddModel(ctx, action.providerId, values);
                          backToMain();
                        },
                        backToMain,
                      );
                      tui.requestRender();
                    }
                  : undefined,
                (model) => useModel(ctx, model.provider, model.id),
                () => toggleHiddenProvider(ctx, action.providerId, true),
              );
            }
            break;
          case "useModel":
            useModel(ctx, action.providerId, action.modelId);
            return;
          case "viewHidden":
            subview = new HiddenProvidersScreen(
              tui,
              theme,
              kb,
              ctx,
              config,
              (innerAction) => {
                if (innerAction.type === "toggleHidden") {
                  toggleHiddenProvider(ctx, innerAction.providerId, false);
                } else {
                  handleAction(innerAction);
                }
              },
              backToMain,
            );
            break;
          case "syncProvider":
            {
              const source = SYNCABLE_PROVIDERS[action.providerId];
              if (!source) {
                notify(ctx, `Provider ${action.providerId} does not support sync`, "error");
                return;
              }
              subview = new ProviderSyncScreen(
                tui,
                theme,
                kb,
                ctx,
                source.label,
                () => source.fetch(ctx),
                (selectedIds, models) => {
                  handleSyncProvider(ctx, action.providerId, selectedIds, models);
                  backToMain();
                },
                backToMain,
              );
            }
            break;
          case "addProvider":
            subview = new AddProviderScreen(
              tui,
              theme,
              kb,
              ctx,
              (values) => {
                handleAddProvider(ctx, values);
                backToMain();
              },
              backToMain,
            );
            break;
        }
        tui.requestRender();
      }

      const main = new MainScreen(tui, theme, kb, ctx, config, handleAction);

      function toggleHiddenProvider(
        ctx: ExtensionContext | ExtensionCommandContext,
        providerId: string,
        goBack: boolean,
      ): void {
        const hidden = new Set(config.global.hiddenProviderIds);
        const wasHidden = hidden.has(providerId);
        if (wasHidden) {
          hidden.delete(providerId);
        } else {
          hidden.add(providerId);
        }
        config.global.hiddenProviderIds = Array.from(hidden);
        // For providers managed by this extension, hiding also disables them
        // so they disappear from Pi's registry; unhiding re-enables them.
        const managed = config.providers.find((p) => p.id === providerId);
        if (managed) {
          managed.enabled = wasHidden;
        }
        persist();
        apply(ctx);
        main.refresh(config);
        if (goBack) {
          backToMain();
        } else if (subview && "refresh" in subview && typeof (subview as any).refresh === "function") {
          (subview as any).refresh(config);
        }
        tui.requestRender();
        notify(ctx, wasHidden ? `Provider ${providerId} restored` : `Provider ${providerId} hidden`, "info");
      }

      const component: Component = {
        render(width: number) {
          if (subview) return subview.render(width);
          return main.render(width);
        },
        invalidate() {
          main.invalidate();
          subview?.invalidate();
        },
        handleInput(data: string) {
          if (subview) {
            subview.handleInput?.(data);
          } else {
            main.handleInput(data);
          }
        },
      };

      return component;
    });
  }

  function handleSyncProvider(
    ctx: ExtensionContext | ExtensionCommandContext,
    providerId: string,
    selectedIds: string[],
    models: { id: string }[],
  ) {
    const source = SYNCABLE_PROVIDERS[providerId];
    if (!source) {
      notify(ctx, `Provider ${providerId} does not support sync`, "error");
      return;
    }
    if (selectedIds.length === 0) {
      const managed = getManagedProvider(config, providerId);
      if (managed.managedModelIds.length > 0 || (managed.cachedModels?.length ?? 0) > 0) {
        // Empty selection on a previously curated provider disables curation.
        managed.managedModelIds = [];
        managed.cachedModels = undefined;
        persist();
        apply(ctx);
        notify(ctx, `${source.label} curation disabled — Pi's built-in configuration restored`, "info");
      } else {
        notify(ctx, "No models selected", "warning");
      }
      return;
    }
    const managed = getManagedProvider(config, providerId);
    managed.managedModelIds = selectedIds;
    managed.enabled = true;
    managed.cachedModels = models.filter((m) => selectedIds.includes(m.id)).map(source.toCached);
    // Register curated provider immediately.
    const cfg = buildCuratedProviderConfig(ctx, providerId, managed);
    if (!cfg) {
      notify(ctx, `${source.label}: curated models saved, but no API key is configured`, "warning");
      persist();
      return;
    }
    try {
      pi.unregisterProvider(providerId);
      pi.registerProvider(providerId, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, `${source.label} registration failed: ${msg}`, "error");
      return;
    }
    persist();
    notify(ctx, `${source.label}: ${selectedIds.length} model(s) curated`, "info");
  }

  function handleAddProvider(ctx: ExtensionContext | ExtensionCommandContext, values: NewProviderValues) {
    if (config.providers.some((p) => p.id === values.id)) {
      notify(ctx, `Provider ${values.id} already exists`, "error");
      return;
    }
    const managed: ManagedProvider = {
      id: values.id,
      enabled: true,
      useLatestDefault: true,
      managedModelIds: [],
      name: values.name,
      baseUrl: values.baseUrl,
      apiKey: values.apiKey,
      api: values.api,
    };
    config.providers.push(managed);
    try {
      pi.registerProvider(values.id, {
        name: values.name,
        baseUrl: values.baseUrl,
        apiKey: values.apiKey,
        api: values.api,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, `Failed to register provider: ${msg}`, "error");
      return;
    }
    persist();
    notify(ctx, `Provider ${values.name} added`, "info");
  }

  function handleAddModel(
    ctx: ExtensionContext | ExtensionCommandContext,
    providerId: string,
    values: NewModelValues,
  ) {
    const managed = getManagedProvider(config, providerId);
    if (!managed.cachedModels) managed.cachedModels = [];
    if (!managed.cachedModels.some((m) => m.id === values.id)) {
      managed.cachedModels.push({
        id: values.id,
        name: values.name,
        api: managed.api ?? "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: values.contextWindow,
        maxTokens: values.maxTokens,
      });
    }
    if (!managed.managedModelIds.includes(values.id)) {
      managed.managedModelIds.push(values.id);
    }
    const cfg = buildCuratedProviderConfig(ctx, providerId, managed);
    if (cfg) {
      try {
        pi.registerProvider(providerId, cfg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(ctx, `Failed to register model: ${msg}`, "error");
        return;
      }
    }
    persist();
    notify(ctx, `Model ${values.name} added to ${providerId}`, "info");
  }
}
