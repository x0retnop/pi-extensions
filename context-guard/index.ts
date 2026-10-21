import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGuardSettings, saveGuardSettings } from "./config.js";
import { MANAGED_FEATURES, getFeatureById } from "./features.js";
import { applyPromptRules, stripPromptRules } from "./prompt-rules.js";
import { extractSystemPromptFromPayload, mapSystemPromptInPayload } from "./payload.js";
import { syncToolGates } from "./tool-gates.js";
import { ensureSkillsDiscovered, removeSkillsBlock, injectPendingSkills, registerUseSkillCommand } from "./skills.js";
import { buildStatusText, buildBootBannerLines } from "./boot-banner.js";
import { loadSurfaceChrome, queueBootRibbon, takeBootRibbon } from "../common/chrome.js";
import { startDumpCapture } from "./dump.js";
import { registerContextNotices } from "./context-notices.js";
import { registerBashOverride, setBashCwd } from "./bash-override.js";
import { registerContextOverview } from "./overview.js";
import { getActiveRoleFromEntries } from "./prompt-rules.js";
import { injectAgentsIfNeeded } from "./agents-inject.js";
import type { GuardSettings, PromptRuleContext } from "./types.js";
import { DEFAULT_CONTEXT_NOTICES } from "./types.js";

export default function (pi: ExtensionAPI) {
  let settings = loadGuardSettings();
  let bootFallbackTimer: ReturnType<typeof setTimeout> | undefined;

  function syncTools() {
    syncToolGates(pi, settings.features);
  }

  /**
   * One-shot ON-only checklist as transient chat text on session bind.
   * Queued for ui-theme's splash notify so banner + ribbon share one line
   * (back-to-back notify replaces). Fallback notify if ui-theme is absent.
   */
  function showBootBanner(ctx: any, reason: string | undefined) {
    if (bootFallbackTimer) {
      clearTimeout(bootFallbackTimer);
      bootFallbackTimer = undefined;
    }

    if (!ctx?.hasUI) {
      queueBootRibbon([]);
      return;
    }

    let role: string | null = null;
    try {
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      role = getActiveRoleFromEntries(entries);
    } catch {
      // role is decorative
    }

    const lines = buildBootBannerLines(
      settings,
      {
        cwd: ctx.cwd,
        role,
        reason: reason || "start",
      },
      loadSurfaceChrome(),
    );
    queueBootRibbon(lines);
    if (lines.length === 0) return;

    bootFallbackTimer = setTimeout(() => {
      bootFallbackTimer = undefined;
      const leftover = takeBootRibbon();
      if (!leftover?.length) return;
      try {
        if (typeof ctx.ui?.notify === "function") {
          ctx.ui.notify(leftover.join("\n"), "info");
        }
      } catch {
        // never block session start on banner failure
      }
    }, 20);
  }

  pi.on("session_start", (event, ctx) => {
    settings = loadGuardSettings();
    setBashCwd(ctx.cwd);
    ensureSkillsDiscovered(ctx.cwd);
    syncTools();
    try {
      injectAgentsIfNeeded(pi, ctx, settings.agentsInject);
    } catch {
      // never block session start on inject failure
    }
    showBootBanner(ctx, (event as { reason?: string } | undefined)?.reason);
  });

  pi.on("session_shutdown", () => {
    if (bootFallbackTimer) {
      clearTimeout(bootFallbackTimer);
      bootFallbackTimer = undefined;
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    settings = loadGuardSettings();
    setBashCwd(ctx.cwd);
    syncTools();
  });

  // Payload-level enforcement: runs AFTER every extension's before_agent_start
  // (including role-sw), so anything re-appended downstream that matches a
  // disabled rule is stripped here — toggles match what actually leaves.
  // Strip-only and idempotent: when the prompt is already clean this returns
  // undefined and the payload passes through untouched.
  // Registered BEFORE startDumpCapture so the dump sees the enforced payload.
  pi.on("before_provider_request", (event, ctx) => {
    const system = extractSystemPromptFromPayload(event.payload);
    if (system === undefined) return undefined;
    const promptCtx: PromptRuleContext = {
      cwd: ctx.cwd,
      entries: (ctx as any).sessionManager?.getEntries?.() ?? [],
    };
    const strip = (text: string): string => {
      let t = settings.autoSkills === false ? removeSkillsBlock(text) : text;
      return stripPromptRules(t, settings.promptRules, promptCtx);
    };
    if (strip(system) === system) return undefined;
    return mapSystemPromptInPayload(event.payload, strip);
  });

  // Capture live context for full dump.
  startDumpCapture(pi);

  // One-shot 60%/70% context pressure notices (user-shaped via `context` event).
  registerContextNotices(pi, () => settings.contextNotices);

  // Core prompt cleanup + manual skill injection.
  pi.on("before_agent_start", async (event, ctx) => {
    let systemPrompt = event.systemPrompt ?? "";
    const options = (event as any).systemPromptOptions ?? {};
    const entries = (ctx as any).sessionManager?.getEntries?.() ?? [];

    const promptCtx: PromptRuleContext = {
      cwd: ctx.cwd,
      options,
      entries,
    };

    // Auto-skills control: strip the automatic skills block when disabled.
    if (settings.autoSkills === false) {
      systemPrompt = removeSkillsBlock(systemPrompt);
    }

    // Apply prompt rules (date/cwd/agents/etc).
    systemPrompt = applyPromptRules(systemPrompt, settings.promptRules, promptCtx);

    // Manual skill injections queued by /use-skill.
    systemPrompt = injectPendingSkills(systemPrompt);

    if (systemPrompt !== event.systemPrompt) {
      return { systemPrompt };
    }
    return undefined;
  });

  // Command: unified context-guard TUI.
  pi.registerCommand("context-guard", {
    description:
      "Open the Context Guard TUI (rules, gates, skills, inspect, overview, dump). Or toggle: " +
      MANAGED_FEATURES.map((f) => f.id).join(", ") +
      ", autoSkills, agentsInject, reset",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const ids = [...MANAGED_FEATURES.map((f) => f.id), "autoSkills", "agentsInject"];

      if (!arg || arg.toLowerCase() === "status") {
        if (ctx.hasUI) {
          const { runGuardTUI } = await import("./tui.js");
          await runGuardTUI(ctx, pi, {
            settings,
            saveSettings: (s) => {
              settings = s;
              saveGuardSettings(s);
            },
            syncTools,
          });
        } else {
          console.log(buildStatusText(settings));
        }
        return;
      }

      if (arg.toLowerCase() === "reset") {
        settings = {
          promptRules: {},
          features: {},
          autoSkills: true,
          agentsInject: true,
          contextNotices: { ...DEFAULT_CONTEXT_NOTICES },
        };
        saveGuardSettings(settings);
        syncTools();
        const msg = "All guards reset to defaults (every feature ON).";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
        return;
      }

      if (!ids.includes(arg)) {
        const msg = `Unknown feature "${arg}". Valid: ${ids.join(", ")}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
        return;
      }

      const feature = getFeatureById(arg);
      let msg: string;

      if (arg === "autoSkills") {
        const current = settings.autoSkills !== false;
        settings = { ...settings, autoSkills: !current };
        saveGuardSettings(settings);
        msg = `Auto-skills → ${!current ? "ON" : "OFF"}`;
      } else if (arg === "agentsInject") {
        const current = settings.agentsInject !== false;
        settings = { ...settings, agentsInject: !current };
        saveGuardSettings(settings);
        msg = `AGENTS.md first-message inject → ${!current ? "ON" : "OFF"}`;
      } else if (feature?.category === "prompt") {
        const current = settings.promptRules[arg] ?? feature.defaultEnabled;
        settings = {
          ...settings,
          promptRules: { ...settings.promptRules, [arg]: !current },
        };
        saveGuardSettings(settings);
        msg = `Prompt rule "${arg}" (${feature.label}) → ${!current ? "ON" : "OFF"}`;
      } else if (feature?.category === "tools") {
        const current = settings.features[arg] ?? feature.defaultEnabled;
        settings = {
          ...settings,
          features: { ...settings.features, [arg]: !current },
        };
        saveGuardSettings(settings);
        syncTools();
        msg = `Tool gate "${arg}" (${feature.label}) → ${!current ? "ON" : "OFF"}`;
      } else if (feature?.category === "skills") {
        const current = settings.autoSkills !== false;
        settings = { ...settings, autoSkills: !current };
        saveGuardSettings(settings);
        msg = `${feature.label} → ${!current ? "ON" : "OFF"}`;
      } else {
        msg = `Unknown feature category for "${arg}".`;
      }

      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      else console.log(msg);
    },
  });

  // /context overview command + skill-loaded tracking.
  registerContextOverview(pi);

  // Register skill quick command.
  registerUseSkillCommand(pi);

  // Override built-in bash with focused description and guidelines.
  registerBashOverride(pi);
}
