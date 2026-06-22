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
import { openRouterModelToCached } from "./openrouter.js";
import { MainScreen } from "./ui/main-screen.js";
import { ProviderDetail } from "./ui/provider-detail.js";
import { SettingsScreen } from "./ui/settings-screen.js";
import { OpenRouterSyncScreen } from "./ui/openrouter-sync.js";
import { AddProviderScreen, type NewProviderValues } from "./ui/add-provider.js";
import { AddModelScreen, type NewModelValues } from "./ui/add-model.js";
import type { OpenRouterModel } from "./openrouter.js";

const CUSTOM_TYPE = "model-manager-state";

export default function modelManagerExtension(pi: ExtensionAPI) {
  let config = loadConfig();

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
    if (ctx.hasUI) {
      ctx.ui.setStatus("model-manager", ctx.ui.theme.fg("accent", "mm"));
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
        notify(ctx, "/mm shortcuts: ↑↓ navigate · Enter open/use · u use default · Space manage · * favorite · a all/none · / filter · s sync (OpenRouter) · Esc/q close", "info");
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
              const view = getProviderView(ctx, config.providers, action.providerId);
              if (!view) {
                notify(ctx, `Provider ${action.providerId} not found`, "error");
                return;
              }
              const isCustom = !isBuiltInProvider(action.providerId);
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
                action.providerId === "openrouter"
                  ? () => {
                      subview = new OpenRouterSyncScreen(
                        tui,
                        theme,
                        kb,
                        ctx,
                        (selectedIds, models) => {
                          handleOpenRouterSync(ctx, selectedIds, models);
                          backToMain();
                        },
                        backToMain,
                      );
                      tui.requestRender();
                    }
                  : undefined,
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
              );
            }
            break;
          case "useModel":
            useModel(ctx, action.providerId, action.modelId);
            return;
          case "openrouter":
            subview = new OpenRouterSyncScreen(
              tui,
              theme,
              kb,
              ctx,
              (selectedIds, models) => {
                handleOpenRouterSync(ctx, selectedIds, models);
                backToMain();
              },
              backToMain,
            );
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

  function handleOpenRouterSync(
    ctx: ExtensionContext | ExtensionCommandContext,
    selectedIds: string[],
    models: OpenRouterModel[],
  ) {
    if (selectedIds.length === 0) {
      notify(ctx, "No models selected", "warning");
      return;
    }
    const managed = getManagedProvider(config, "openrouter");
    managed.managedModelIds = selectedIds;
    managed.enabled = true;
    managed.cachedModels = models.filter((m) => selectedIds.includes(m.id)).map(openRouterModelToCached);
    // Register curated OpenRouter provider immediately.
    const cfg = buildCuratedProviderConfig(ctx, "openrouter", managed);
    if (cfg) {
      try {
        pi.registerProvider("openrouter", cfg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(ctx, `OpenRouter registration failed: ${msg}`, "error");
        return;
      }
    }
    persist();
    notify(ctx, `OpenRouter: ${selectedIds.length} model(s) curated`, "info");
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
