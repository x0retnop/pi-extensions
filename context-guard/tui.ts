import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MANAGED_FEATURES, getFeatureById } from "./features.js";
import type { GuardSettings } from "./types.js";
import { DEFAULT_CONTEXT_NOTICES } from "./types.js";
import { buildInspectReport } from "./inspect.js";
import { refreshSkills, buildSkillStatus } from "./skills.js";
import { openTextViewer } from "./viewer.js";
import {
  clearContextNoticesFired,
  getContextNoticesFired,
  reloadContextNoticePrompts,
} from "./context-notices.js";

export {
  buildBootBanner,
  buildBootBannerLines,
  buildStatusText,
  type BootBannerInfo,
} from "./boot-banner.js";

/** Human-first menu row; id kept at end for parsing toggles. */
function formatMenuItem(id: string, label: string, enabled: boolean): string {
  return `${enabled ? "●" : "○"}  ${label}  [${id}]`;
}

function parseIdFromMenuItem(item: string): string | undefined {
  const match = item.match(/\[([^\]]+)\]\s*$/);
  return match?.[1];
}

export interface TUIDeps {
  settings: GuardSettings;
  saveSettings: (s: GuardSettings) => void;
  syncTools: () => void;
}

export interface TUIContext {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  deps: TUIDeps;
}

export async function runGuardTUI(ctx: ExtensionCommandContext, pi: ExtensionAPI, deps: TUIDeps) {
  const mainOptions = [
    "🎛  Prompt in context",
    "🔧 Tools",
    "📦 Skills",
    "📈 Notices (context pressure)",
    "🔍 Inspect prompt breakdown",
    "📊 Context overview",
    "💾 Dump provider prompt",
    "💾 Dump full context",
    "↺ Reset all guards",
    "✓ Done",
  ];

  while (true) {
    const choice = await ctx.ui.select("Context Guard — main menu", mainOptions);
    if (!choice || choice === "✓ Done") return;

    if (choice === "🔍 Inspect prompt breakdown") {
      const prompt = (ctx as any).getSystemPrompt?.() ?? "";
      const options = (ctx as any).getSystemPromptOptions?.() ?? {};
      const entries = (ctx as any).sessionManager?.getEntries?.() ?? [];
      const report = buildInspectReport(prompt, options, deps.settings, entries);
      await openTextViewer(ctx.ui, {
        title: "ctx-inspect",
        text: report,
        subtitle: "guard inspection · read-only",
      });
      continue;
    }

    if (choice === "📊 Context overview") {
      const { runContextOverview } = await import("./overview.js");
      await runContextOverview(ctx, pi);
      continue;
    }

    if (choice === "💾 Dump provider prompt") {
      const { runProviderPromptDump } = await import("./dump.js");
      await runProviderPromptDump(ctx, pi);
      continue;
    }

    if (choice === "💾 Dump full context") {
      const { runContextDump } = await import("./dump.js");
      await runContextDump(ctx, pi);
      continue;
    }

    if (choice === "↺ Reset all guards") {
      const confirmed = await ctx.ui.confirm("Reset all guards?", "This restores every rule, gate, and toggle to its default (everything ON).");
      if (confirmed) {
        deps.settings = {
          promptRules: {},
          features: {},
          autoSkills: true,
          agentsInject: true,
          contextNotices: { ...DEFAULT_CONTEXT_NOTICES },
        };
        deps.saveSettings(deps.settings);
        deps.syncTools();
        clearContextNoticesFired();
        ctx.ui.notify("All guards reset to defaults (everything ON).", "info");
      }
      continue;
    }

    if (choice === "🎛  Prompt in context") {
      await runPromptRulesMenu(ctx, deps);
      continue;
    }

    if (choice === "🔧 Tools") {
      await runToolGatesMenu(ctx, deps);
      continue;
    }

    if (choice === "📦 Skills") {
      await runSkillsMenu(ctx, deps);
      continue;
    }

    if (choice === "📈 Notices (context pressure)") {
      await runContextNoticesMenu(ctx, deps);
      continue;
    }
  }
}

async function runContextNoticesMenu(ctx: ExtensionCommandContext, deps: TUIDeps) {
  while (true) {
    const cn = deps.settings.contextNotices ?? { ...DEFAULT_CONTEXT_NOTICES };
    const fired = getContextNoticesFired();
    const options = [
      formatMenuItem("master", "Master switch", cn.enabled),
      formatMenuItem("notice60", `At 60% context${fired.notice60 ? " · fired" : ""}`, cn.notice60),
      formatMenuItem("notice70", `At 70% context${fired.notice70 ? " · fired" : ""}`, cn.notice70),
      "",
      "↺ Clear fired flags (allow re-fire)",
      "↻ Reload prompt files (notice-60.md / notice-70.md)",
      "← Back",
    ];

    const choice = await ctx.ui.select("Notices (context pressure)", options);
    if (!choice || choice === "← Back") return;

    if (choice === "↺ Clear fired flags (allow re-fire)") {
      clearContextNoticesFired();
      ctx.ui.notify("Context notice fired flags cleared.", "info");
      continue;
    }

    if (choice === "↻ Reload prompt files (notice-60.md / notice-70.md)") {
      reloadContextNoticePrompts();
      ctx.ui.notify("Reloaded notice-60.md / notice-70.md from extension root.", "info");
      continue;
    }

    const id = parseIdFromMenuItem(choice);
    if (!id) continue;

    const next = { ...cn };
    if (id === "master") {
      next.enabled = !cn.enabled;
      ctx.ui.notify(`Context notices master → ${next.enabled ? "ON" : "OFF"}`, "info");
    } else if (id === "notice60") {
      next.notice60 = !cn.notice60;
      ctx.ui.notify(`60% notice → ${next.notice60 ? "ON" : "OFF"}`, "info");
    } else if (id === "notice70") {
      next.notice70 = !cn.notice70;
      ctx.ui.notify(`70% notice → ${next.notice70 ? "ON" : "OFF"}`, "info");
    } else {
      continue;
    }

    deps.settings = { ...deps.settings, contextNotices: next };
    deps.saveSettings(deps.settings);
  }
}

async function runPromptRulesMenu(ctx: ExtensionCommandContext, deps: TUIDeps) {
  const rules = MANAGED_FEATURES.filter((f) => f.category === "prompt");

  while (true) {
    const options = [
      formatMenuItem("agentsInject", "Inject AGENTS.md as first message", deps.settings.agentsInject !== false),
      ...rules.map((f) =>
        formatMenuItem(f.id, f.label, deps.settings.promptRules[f.id] ?? f.defaultEnabled),
      ),
      "",
      "← Back",
    ];

    const choice = await ctx.ui.select("Prompt in context", options);
    if (!choice || choice === "← Back") return;

    const id = parseIdFromMenuItem(choice);
    if (id === "agentsInject") {
      const current = deps.settings.agentsInject !== false;
      deps.settings = { ...deps.settings, agentsInject: !current };
      deps.saveSettings(deps.settings);
      ctx.ui.notify(`Inject AGENTS.md as first message → ${!current ? "ON" : "OFF"}`, "info");
      continue;
    }
    const feature = id ? getFeatureById(id) : undefined;
    if (!feature || feature.category !== "prompt") continue;

    const current = deps.settings.promptRules[id!] ?? feature.defaultEnabled;
    deps.settings = {
      ...deps.settings,
      promptRules: { ...deps.settings.promptRules, [id!]: !current },
    };
    deps.saveSettings(deps.settings);
    ctx.ui.notify(`${feature.label} → ${!current ? "ON" : "OFF"}`, "info");
  }
}

async function runToolGatesMenu(ctx: ExtensionCommandContext, deps: TUIDeps) {
  const gates = MANAGED_FEATURES.filter((f) => f.category === "tools");

  while (true) {
    const options = gates.map((f) =>
      formatMenuItem(f.id, f.label, deps.settings.features[f.id] ?? f.defaultEnabled),
    );
    options.push("", "← Back");

    const choice = await ctx.ui.select("Tools", options);
    if (!choice || choice === "← Back") return;

    const id = parseIdFromMenuItem(choice);
    const feature = id ? getFeatureById(id) : undefined;
    if (!feature || feature.category !== "tools") continue;

    const current = deps.settings.features[id!] ?? feature.defaultEnabled;
    deps.settings = {
      ...deps.settings,
      features: { ...deps.settings.features, [id!]: !current },
    };
    deps.saveSettings(deps.settings);
    deps.syncTools();
    ctx.ui.notify(`${feature.label} → ${!current ? "ON" : "OFF"}`, "info");
  }
}

async function runSkillsMenu(ctx: ExtensionCommandContext, deps: TUIDeps) {
  refreshSkills(ctx.cwd);

  while (true) {
    const autoEnabled = deps.settings.autoSkills !== false;
    const options = [
      formatMenuItem("autoSkills", "Auto-inject skill list into prompt", autoEnabled),
      "",
      "📋 List discovered skills",
      "← Back",
    ];

    const choice = await ctx.ui.select("Skills", options);
    if (!choice || choice === "← Back") return;

    if (choice === "📋 List discovered skills") {
      const text = buildSkillStatus(deps.settings.autoSkills !== false);
      await openTextViewer(ctx.ui, { title: "skills", text });
      continue;
    }

    const id = parseIdFromMenuItem(choice);
    if (id === "autoSkills") {
      deps.settings = { ...deps.settings, autoSkills: !autoEnabled };
      deps.saveSettings(deps.settings);
      ctx.ui.notify(`Auto-skills → ${!autoEnabled ? "ON" : "OFF"}`, "info");
    }
  }
}
