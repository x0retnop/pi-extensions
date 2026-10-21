import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import type { ManagedProvider, ModelManagerConfig, UiAction, CycleHotkeysPreset } from "./types.js";
import { loadConfig, saveConfig, getManagedProvider } from "./config.js";
import {
  applyCuratedRegistrations,
  createApplyMemo,
  getProviderView,
  buildCuratedProviderConfig,
  isBuiltInProvider,
  enrichCachedModel,
  repairManagedCaches,
  getDefaultModelForProvider,
  isCuratableProvider,
  hasModelScope,
  isModelInScope,
  findScopedThinkingLevel,
} from "./provider-utils.js";
import { fetchOpenRouterModels, openRouterModelToCached } from "./openrouter.js";
import { fetchOpencodeModels, opencodeModelToCached } from "./opencode.js";
import { fetchNanoGptModels, nanoGptModelToCached } from "./nanogpt.js";
import { fetchModelsDevSpecs, MODELS_DEV_PROVIDERS, type ModelsDevSpec } from "./models-dev.js";
import { toPiInput } from "./wire-compat.js";
import { writePiDefault } from "./pi-default.js";
import type { NewProviderValues } from "./ui/add-provider.js";
import type { NewModelValues } from "./ui/add-model.js";
import { hasApiKeyForProvider } from "./usage.js";
import type { CachedModel, FavoriteItem } from "./types.js";
import { modelRoleMapKey } from "../role-sw/config.js";
import {
  grokThinkCommandStatus,
  toGrokThinkRef,
  transformGrokThinkingMarkdown,
  type GrokThinkModelRef,
} from "./grok-think.js";

const CUSTOM_TYPE = "model-manager-state";

async function loadManagerScreens() {
  const [
    { MainScreen },
    { ProviderDetail },
    { SettingsScreen },
    { RoleMapScreen },
    { ProviderSyncScreen },
    { HiddenProvidersScreen },
    { AddProviderScreen },
    { AddModelScreen },
    { UsageSubview },
  ] = await Promise.all([
    import("./ui/main-screen.js"),
    import("./ui/provider-detail.js"),
    import("./ui/settings-screen.js"),
    import("./ui/role-map-screen.js"),
    import("./ui/provider-sync.js"),
    import("./ui/hidden-providers.js"),
    import("./ui/add-provider.js"),
    import("./ui/add-model.js"),
    import("./ui/usage-screen.js"),
  ]);
  return {
    MainScreen,
    ProviderDetail,
    SettingsScreen,
    RoleMapScreen,
    ProviderSyncScreen,
    HiddenProvidersScreen,
    AddProviderScreen,
    AddModelScreen,
    UsageSubview,
  };
}

export default function modelManagerExtension(pi: ExtensionAPI) {
  let config = loadConfig();
  let currentThinkModel: GrokThinkModelRef | undefined;

  function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function trackThinkModel(model: { provider?: string; id?: string; name?: string; baseUrl?: string } | undefined): void {
    currentThinkModel = toGrokThinkRef(model);
  }

  // Display-only: collapse Grok 4.5+ summary. Must run in child processes too
  // (a grok child would otherwise stream the gray wall).
  pi.registerMarkdownTransformer((md, ctx) =>
    transformGrokThinkingMarkdown(md, ctx.messageType, currentThinkModel, config.global.hideGrokThinking),
  );

  // ── Sub-agent child mode ──
  // Children get curated provider registrations (opencode-go etc. are needed to
  // resolve the agent's --model), but model-manager must NOT touch the active
  // model (no restoreDefaultOrLastUsed — the runner sets --model explicitly)
  // and must NOT pollute lastUsedModel with child runs.
  if (process.env.PI_SUB_AGENTS_CHILD === "1") {
    pi.on("session_start", async (_event, ctx) => {
      config = loadConfig();
      trackThinkModel(ctx.model);
      await applyCuratedRegistrations(pi, ctx, config.providers);
    });
    pi.on("model_select", (event) => {
      trackThinkModel(event.model);
    });
    return;
  }

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
        const apiKey =
          (await ctx.modelRegistry.getApiKeyForProvider("openrouter")) ?? process.env.OPENROUTER_API_KEY;
        return fetchOpenRouterModels(apiKey);
      },
      toCached: openRouterModelToCached,
    },
    "opencode-go": {
      label: "OpenCode Go",
      fetch: async (ctx) => {
        const apiKey =
          (await ctx.modelRegistry.getApiKeyForProvider("opencode-go")) ?? process.env.OPENCODE_API_KEY;
        return fetchOpencodeModels(apiKey);
      },
      toCached: opencodeModelToCached,
    },
    "nano-gpt": {
      label: "NanoGPT",
      fetch: async (ctx) => {
        const apiKey =
          (await ctx.modelRegistry.getApiKeyForProvider("nano-gpt")) ?? process.env.NANOGPT_API_KEY;
        return fetchNanoGptModels(apiKey);
      },
      toCached: nanoGptModelToCached,
    },
  };

  /**
   * Persist model-manager.json. Notifies on failure only (success is silent for
   * hot paths like lastUsedModel; callers that need success feedback pass successMessage).
   */
  function persist(ctx?: ExtensionContext | ExtensionCommandContext, opts?: { successMessage?: string }): boolean {
    const ok = saveConfig(config);
    if (!ok) {
      if (ctx?.hasUI) {
        notify(ctx, "Failed to save model-manager.json", "error");
      } else {
        console.error("[model-manager] Failed to save model-manager.json");
      }
      return false;
    }
    if (opts?.successMessage && ctx?.hasUI) {
      notify(ctx, opts.successMessage, "info");
    }
    // Session marker is best-effort; a failure must not undo a successful disk write.
    try {
      pi.appendEntry(CUSTOM_TYPE, { updatedAt: Date.now() });
    } catch (err) {
      console.error(`[model-manager] appendEntry failed: ${err}`);
    }
    return true;
  }

  let applyMemo = createApplyMemo();

  async function apply(ctx: ExtensionContext | ExtensionCommandContext) {
    try {
      applyMemo = await applyCuratedRegistrations(pi, ctx, config.providers, applyMemo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, `Provider registration failed: ${msg}`, "error");
    }
  }

  /** Resolve a role-map key for a favorite (provider-only → default model). Never uses empty modelId. */
  function resolveFavoriteMapKey(
    ctx: ExtensionContext | ExtensionCommandContext,
    favorite: FavoriteItem,
  ): string | undefined {
    const model = favorite.modelId
      ? ctx.modelRegistry.find(favorite.providerId, favorite.modelId)
      : getDefaultModelForProvider(ctx, favorite.providerId);
    return modelRoleMapKey(model);
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    trackThinkModel(ctx.model);
    // Upgrade bare sync stubs / missing Kimi multi-turn compat in place.
    if (repairManagedCaches(config)) {
      persist(ctx);
    }
    await apply(ctx);
    trackThinkModel(ctx.model);
  });

  pi.on("model_select", async (event, ctx) => {
    trackThinkModel(event.model);
    if (!config.global.rememberLastUsed) return;
    const providerId = event.model.provider;
    const managed = config.providers.find((p) => p.id === providerId);
    if (managed) {
      managed.lastUsedModel = event.model.id;
      persist(ctx);
    }
  });

  // session_tree does not replace ModelRuntime or curation — skip apply.

  // ── Favorite model cycle hotkeys ──
  function getCycleHotkeyIds(preset: CycleHotkeysPreset): { prev: KeyId | undefined; next: KeyId | undefined } {
    switch (preset) {
      case "ctrl+f2":
        return { prev: Key.ctrl("f2"), next: Key.ctrl("f3") };
      case "f2":
        return { prev: Key.f2, next: Key.f3 };
      case "ctrl+shift+arrows":
        return { prev: Key.ctrlShift("up"), next: Key.ctrlShift("down") };
      default:
        return { prev: undefined, next: undefined };
    }
  }

  function registerCycleShortcut(keyId: KeyId | undefined, delta: number) {
    if (!keyId) return;
    pi.registerShortcut(keyId, {
      description: delta > 0 ? "Next favorite model" : "Previous favorite model",
      handler: async (ctx) => {
        try {
          await cycleFavorite(ctx, delta);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notify(ctx, `Favorite cycle failed: ${msg}`, "error");
        }
      },
    });
  }

  const cycleHotkeys = getCycleHotkeyIds(config.global.cycleHotkeys);
  registerCycleShortcut(cycleHotkeys.prev, -1);
  registerCycleShortcut(cycleHotkeys.next, 1);

  async function cycleFavorite(ctx: ExtensionContext | ExtensionCommandContext, delta: number) {
    if (!ctx.isIdle()) {
      notify(ctx, "Wait until the agent is idle", "warning");
      return;
    }
    const cfg = loadConfig();
    const cycle: Model<any>[] = [];
    const unresolved: string[] = [];
    const outOfScope: string[] = [];
    const scoped = hasModelScope(ctx);
    for (const fav of cfg.favorites) {
      const model = fav.modelId
        ? ctx.modelRegistry.find(fav.providerId, fav.modelId)
        : getDefaultModelForProvider(ctx, fav.providerId);
      if (!model) {
        unresolved.push(`${fav.providerId}/${fav.modelId ?? "(default)"}`);
        continue;
      }
      // When session scope is active, only cycle favorites inside it
      // (mirrors built-in /model picker).
      if (scoped && !isModelInScope(ctx, model.provider, model.id)) {
        outOfScope.push(`${model.provider}/${model.id}`);
        continue;
      }
      cycle.push(model);
    }
    if (cycle.length === 0) {
      let hint: string;
      if (cfg.favorites.length === 0) {
        hint = "Pin favorites with * in /mm first";
      } else if (scoped && outOfScope.length > 0 && unresolved.length === 0) {
        hint = `all ${outOfScope.length} favorite(s) are outside session scope (enabledModels / --models)`;
      } else {
        hint =
          `None of ${cfg.favorites.length} favorite(s) resolve in registry` +
          (unresolved.length ? `: ${unresolved.slice(0, 3).join(", ")}` : "");
      }
      notify(ctx, `No favorite models to cycle — ${hint}`, "warning");
      return;
    }
    const current = ctx.model;
    let idx = current
      ? cycle.findIndex((m) => m.provider === current.provider && m.id === current.id)
      : -1;

    // Walk the ring; skip models that fail setModel (missing API key).
    for (let attempt = 0; attempt < cycle.length; attempt++) {
      idx = (idx + delta + cycle.length) % cycle.length;
      const next = cycle[idx];
      // Already on this model (only possible if delta wraps a 1-item cycle)
      if (current && next.provider === current.provider && next.id === current.id) {
        if (cycle.length === 1) {
          notify(ctx, `Already on only favorite: ${next.name ?? next.id}`, "info");
          return;
        }
        continue;
      }
      const ok = await pi.setModel(next);
      if (!ok) {
        continue;
      }
      // Apply thinking level pinned by scope pattern (e.g. provider/*:high).
      const pinnedLevel = findScopedThinkingLevel(ctx, next.provider, next.id);
      if (pinnedLevel) {
        try {
          pi.setThinkingLevel(pinnedLevel as any);
        } catch {
          // Older runtimes / invalid levels — model switch still counts.
        }
      }
      const managed = cfg.providers.find((p) => p.id === next.provider);
      if (managed) {
        managed.lastUsedModel = next.id;
        if (!saveConfig(cfg)) {
          // Keep module-level config in sync if disk write failed for a separate load.
          notify(ctx, `Switched to ${next.name ?? next.id}, but failed to save last-used model`, "warning");
          return;
        }
        // Keep in-memory config aligned with what we just wrote.
        const live = config.providers.find((p) => p.id === next.provider);
        if (live) live.lastUsedModel = next.id;
      }
      notify(ctx, `Switched to ${next.name ?? next.id} (${next.provider})`, "info");
      return;
    }
    notify(ctx, "No favorite model with a configured API key", "warning");
  }

  pi.registerCommand("fav", {
    description: "Cycle favorite models (same as hotkeys). /fav next|prev",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      const delta = a === "prev" || a === "p" || a === "-" ? -1 : 1;
      await cycleFavorite(ctx, delta);
    },
  });

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

  pi.registerCommand("grok-think", {
    description: "Grok 4.5+ thinking summary display. /grok-think [hide|show|status] (off=hide, on=show)",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      trackThinkModel(ctx.model);
      // User language: off = don't show the gray wall. hide/show are the precise words.
      if (a === "hide" || a === "off") {
        config.global.hideGrokThinking = true;
        persist(ctx, { successMessage: grokThinkCommandStatus(true, currentThinkModel) });
        return;
      }
      if (a === "show" || a === "on") {
        config.global.hideGrokThinking = false;
        persist(ctx, { successMessage: grokThinkCommandStatus(false, currentThinkModel) });
        return;
      }
      if (a && a !== "status") {
        notify(ctx, "Usage: /grok-think [hide|show|status]", "warning");
        return;
      }
      notify(ctx, grokThinkCommandStatus(config.global.hideGrokThinking, currentThinkModel), "info");
    },
  });

  pi.registerCommand("usage", {
    description: "Fetch and display provider usage quotas (model-manager).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notify(ctx, "Usage view requires TUI mode.", "warning");
        return;
      }
      await openUsage(ctx);
    },
  });

  async function openUsage(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    const model = ctx.model;
    if (!model) {
      notify(ctx, "No model selected — usage shows the active provider.", "warning");
      return;
    }

    const providerId = model.provider;
    const hasKey = await hasApiKeyForProvider(ctx, providerId);
    if (!hasKey) {
      notify(ctx, `No API key configured for active provider ${providerId}`, "warning");
    }

    notify(ctx, "Fetching usage quotas for active provider...", "info");
    const { UsageScreen, createUsageController, saveUsageState } = await import("./ui/usage-screen.js");
    let controller: Awaited<ReturnType<typeof createUsageController>>;
    try {
      controller = await createUsageController(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, msg, "warning");
      return;
    }

    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      const screen = new UsageScreen(
        tui,
        theme,
        kb,
        ctx,
        controller.state,
        controller.refreshActive,
        controller.refreshAll,
        controller.setPinned,
        () => done(),
      );
      return {
        render: (width: number) => screen.render(width),
        invalidate: () => screen.invalidate(),
        handleInput: (data: string) => screen.handleInput(data),
      };
    });
    saveUsageState(controller.state);
  }


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
    const pinnedLevel = findScopedThinkingLevel(ctx, providerId, modelId);
    if (pinnedLevel) {
      try {
        pi.setThinkingLevel(pinnedLevel as any);
      } catch {
        // ignore
      }
    }
    const managed = config.providers.find((p) => p.id === providerId);
    if (managed) {
      managed.lastUsedModel = modelId;
      if (!persist(ctx)) {
        notify(ctx, `Using ${model.name}, but failed to save last-used model`, "warning");
        return;
      }
    }
    const scopeNote =
      hasModelScope(ctx) && !isModelInScope(ctx, providerId, modelId)
        ? " · outside session scope"
        : "";
    notify(ctx, `Using ${model.name} (${providerId}/${modelId})${scopeNote}`, "info");
  }

  /** Ids infer-local registered. Sync callback; empty if that extension is not loaded. */
  function inferLocalProviderIds(): string[] {
    let ids: string[] = [];
    pi.events.emit("infer-local:providers", { ids: (next: string[]) => { ids = next; } });
    return ids;
  }

  /** Probe the gateway and rewrite infer-local rows. Resolves even if the extension is absent. */
  function refreshInferLocal(): Promise<{ ok: boolean; line: string }> {
    return new Promise((resolve) => {
      let acked = false;
      pi.events.emit("infer-local:refresh", {
        ack: () => { acked = true; },
        done: (result: { ok: boolean; line: string }) => resolve(result),
      });
      if (!acked) resolve({ ok: false, line: "infer-local is not loaded" });
    });
  }

  async function openModelManager(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    config = loadConfig();
    const {
      MainScreen,
      ProviderDetail,
      SettingsScreen,
      RoleMapScreen,
      ProviderSyncScreen,
      HiddenProvidersScreen,
      AddProviderScreen,
      AddModelScreen,
      UsageSubview,
    } = await loadManagerScreens();
    // Never nest ui.select/confirm inside this custom UI — that leaves the outer
    // promise pending and makes /mm appear dead until a full Pi reload
    // (same class of bug as pi-session-memory before overlay + pure subviews).
    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      let subview: Component | undefined;
      let settled = false;

      function safeDone() {
        if (settled) return;
        settled = true;
        done();
      }

      function backToMain() {
        subview = undefined;
        main.refresh(config);
        tui.requestRender();
      }

      function showHelp() {
        notify(ctx, "/mm shortcuts: ↑↓ navigate · [ ] (or K/J) reorder favorites · Enter open/use · u use default · d set Pi startup default · h hide · * pin · m map role · / filter · g/G top/bottom · ? help · Esc/q close", "info");
      }

      async function handleAction(action: UiAction) {
        try {
          await dispatchAction(action);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[model-manager] action ${action.type} failed: ${err}`);
          notify(ctx, `Model manager error (${action.type}): ${msg}`, "error");
          tui.requestRender();
        }
      }

      async function dispatchAction(action: UiAction) {
        switch (action.type) {
          case "close":
            safeDone();
            return;
          case "help":
            showHelp();
            return;
          case "refresh":
            config = loadConfig();
            await apply(ctx);
            // Triggers ProviderConfig.refreshModels for curated openrouter/opencode-go.
            try {
              await ctx.modelRegistry.refresh();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              notify(ctx, `Registry refresh partially failed: ${msg}`, "warning");
            }
            main.refresh(config);
            notify(ctx, "Model manager refreshed", "info");
            return;
          case "persist":
            // Favorites / silent edits: report failure only.
            persist(ctx);
            return;
          case "setDefault": {
            const target = action.providerId && action.modelId
              ? { provider: action.providerId, modelId: action.modelId }
              : undefined;
            if (!writePiDefault(target)) {
              notify(ctx, "Failed to write settings.json — startup default unchanged", "error");
              return;
            }
            notify(
              ctx,
              target
                ? `Pi startup default: ${target.provider}/${target.modelId} (new sessions)`
                : "Pi startup default cleared — Pi picks its own",
              "info",
            );
            main.refresh(config);
            return;
          }
          case "toggleHidden": {
            toggleHiddenProvider(ctx, action.providerId, false);
            return;
          }
          case "settings":
            subview = new SettingsScreen(tui, theme, kb, ctx, config, (updated) => {
              config = updated;
              if (persist(ctx, { successMessage: "Settings saved" })) {
                void apply(ctx);
              }
              main.refresh(config);
            }, backToMain);
            break;
          case "provider":
            {
              subview = undefined;
              const view = getProviderView(ctx, config, action.providerId);
              if (!view) {
                notify(ctx, `Provider ${action.providerId} not found`, "error");
                return;
              }
              const isCustom = !isBuiltInProvider(action.providerId);
              const syncSource = SYNCABLE_PROVIDERS[action.providerId];
              const inferRefresh = inferLocalProviderIds().includes(action.providerId);
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
                  if (persist(ctx)) {
                    void apply(ctx);
                  }
                  main.refresh(config);
                },
                backToMain,
                inferRefresh
                  ? () => {
                      void refreshInferLocal().then((result) => {
                        notify(ctx, result.line, result.ok ? "info" : "warning");
                        main.refresh(config);
                        void handleAction({ type: "provider", providerId: action.providerId });
                      });
                    }
                  : syncSource
                  ? () => {
                      const already = config.providers.find((p) => p.id === action.providerId)?.managedModelIds ?? [];
                      subview = new ProviderSyncScreen(
                        tui,
                        theme,
                        kb,
                        ctx,
                        syncSource.label,
                        () => syncSource.fetch(ctx),
                        (selectedIds, models) => {
                          void handleSyncProvider(ctx, action.providerId, selectedIds, models);
                          // Re-open provider detail so the curated list is visible immediately.
                          void handleAction({ type: "provider", providerId: action.providerId });
                        },
                        () => void handleAction({ type: "provider", providerId: action.providerId }),
                        already,
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
                          void handleAddModel(ctx, action.providerId, values);
                          backToMain();
                        },
                        backToMain,
                      );
                      tui.requestRender();
                    }
                  : undefined,
                (model) => void useModel(ctx, model.provider, model.id),
                () => toggleHiddenProvider(ctx, action.providerId, true),
                MODELS_DEV_PROVIDERS.has(action.providerId) &&
                isCuratableProvider(action.providerId, view.managed)
                  ? () => {
                      void handleUpdateSpecs(ctx, action.providerId).then(() => {
                        main.refresh(config);
                        void handleAction({ type: "provider", providerId: action.providerId });
                      });
                    }
                  : undefined,
                inferRefresh ? "→ Refresh from gateway" : undefined,
              );
            }
            break;
          case "useModel":
            await useModel(ctx, action.providerId, action.modelId);
            tui.requestRender();
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
                  void handleAction(innerAction);
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
              const already = config.providers.find((p) => p.id === action.providerId)?.managedModelIds ?? [];
              subview = new ProviderSyncScreen(
                tui,
                theme,
                kb,
                ctx,
                source.label,
                () => source.fetch(ctx),
                (selectedIds, models) => {
                  void handleSyncProvider(ctx, action.providerId, selectedIds, models);
                  void handleAction({ type: "provider", providerId: action.providerId });
                },
                backToMain,
                already,
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
          case "usage":
            subview = new UsageSubview(tui, theme, kb, ctx, backToMain);
            tui.requestRender();
            return;
          case "assignRole": {
            // Pure subview — never nest ctx.ui.select inside ui.custom.
            const focusKey = resolveFavoriteMapKey(ctx, action.favorite);
            if (!focusKey && action.favorite.modelId) {
              notify(
                ctx,
                `Model ${action.favorite.providerId}/${action.favorite.modelId} not in registry — pin after it is registered`,
                "warning",
              );
              tui.requestRender();
              return;
            }
            if (!focusKey) {
              notify(
                ctx,
                `No default model for ${action.favorite.providerId} — open the provider and pin a concrete model first`,
                "warning",
              );
              tui.requestRender();
              return;
            }
            subview = new RoleMapScreen(
              tui,
              theme,
              kb,
              ctx,
              config,
              backToMain,
              { focusKey, autoOpenRolePicker: true },
            );
            break;
          }
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
        if (!persist(ctx)) {
          tui.requestRender();
          return;
        }
        void apply(ctx);
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

  async function handleSyncProvider(
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
    const managed = getManagedProvider(config, providerId);
    if (selectedIds.length === 0) {
      if (managed.managedModelIds.length > 0 || (managed.cachedModels?.length ?? 0) > 0) {
        // Empty selection on a previously curated provider disables curation.
        managed.managedModelIds = [];
        managed.cachedModels = undefined;
        if (!persist(ctx)) return;
        await apply(ctx);
        notify(ctx, `${source.label} curation disabled — Pi's built-in configuration restored`, "info");
      } else {
        notify(ctx, "No models selected — press Space to toggle, then Enter to save", "warning");
      }
      return;
    }
    // Preserve order of selection against the fetched list for stable diffs.
    const selectedSet = new Set(selectedIds);
    managed.managedModelIds = models.filter((m) => selectedSet.has(m.id)).map((m) => m.id);
    managed.enabled = true;
    // Enrich with Pi built-in catalog (api/compat/maxTokens). Bare /models stubs
    // lack compat.maxTokensField and break Kimi/etc. on OpenCode Go with 400s.
    managed.cachedModels = managed.managedModelIds.map((id) => {
      const raw = models.find((m) => m.id === id);
      const stub = raw ? source.toCached(raw) : source.toCached({ id } as any);
      return enrichCachedModel(providerId, id, stub);
    });
    // Always persist first so a failed re-register still keeps the selection.
    if (!persist(ctx)) return;
    const cfg = await buildCuratedProviderConfig(ctx, providerId, managed);
    if (!cfg) {
      notify(ctx, `${source.label}: ${selectedIds.length} model(s) saved, but no API key is configured`, "warning");
      return;
    }
    try {
      pi.unregisterProvider(providerId);
      pi.registerProvider(providerId, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, `${source.label}: saved, but registration failed: ${msg}`, "error");
      return;
    }
    notify(ctx, `${source.label}: ${selectedIds.length} model(s) curated`, "info");
  }

  /**
   * Manual pull of model specs from models.dev (provider detail → "Update model
   * specs"). On demand only: the payload is ~4.7 MB, so this is wired to nothing
   * automatic. Results land in managed.overrides and win over the built-in
   * catalog at resolve time (patchCuratedModelDef).
   */
  async function handleUpdateSpecs(
    ctx: ExtensionContext | ExtensionCommandContext,
    providerId: string,
  ) {
    const managed = getManagedProvider(config, providerId);
    const ids = managed.managedModelIds;
    if (ids.length === 0) {
      notify(ctx, `Curate ${providerId} models first — nothing to update`, "warning");
      return;
    }
    let specs: Record<string, ModelsDevSpec>;
    try {
      specs = await fetchModelsDevSpecs(providerId, ids);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, `models.dev: ${msg}`, "error");
      return;
    }
    const found = Object.keys(specs);
    if (found.length === 0) {
      notify(ctx, `models.dev has no entry for the curated ${providerId} models`, "warning");
      return;
    }
    const overrides = { ...(managed.overrides ?? {}) };
    for (const [id, spec] of Object.entries(specs)) {
      // `input` is what Pi reads to decide whether to send/strip images; derive it
      // from the pulled modalities or a model absent from the catalog stays
      // text-only and silently loses vision.
      const input = toPiInput(spec.inputModalities);
      overrides[id] = {
        ...(overrides[id] ?? {}),
        ...spec,
        ...(input ? { input } : {}),
      };
    }
    managed.overrides = overrides;
    managed.specsPulledAt = new Date().toISOString();
    if (!persist(ctx)) return;
    await apply(ctx);
    notify(ctx, `Specs updated: ${found.length} model(s) from models.dev`, "info");
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
      // Roll back the in-memory add so a failed register does not leave a ghost entry.
      config.providers = config.providers.filter((p) => p.id !== values.id);
      const msg = err instanceof Error ? err.message : String(err);
      notify(ctx, `Failed to register provider: ${msg}`, "error");
      return;
    }
    if (!persist(ctx)) {
      notify(ctx, `Provider ${values.name} registered in this session, but save failed`, "warning");
      return;
    }
    notify(ctx, `Provider ${values.name} added`, "info");
  }

  async function handleAddModel(
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
    // Persist before re-registering so the selection survives a crash even if
    // registration fails.
    if (!persist(ctx)) return;
    const cfg = await buildCuratedProviderConfig(ctx, providerId, managed);
    if (cfg) {
      try {
        pi.unregisterProvider(providerId);
        pi.registerProvider(providerId, cfg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(ctx, `Saved, but registration failed: ${msg}`, "error");
        return;
      }
    }
    notify(ctx, `Model ${values.name} added to ${providerId}`, "info");
  }
}
