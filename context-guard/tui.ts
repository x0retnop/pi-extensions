import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MANAGED_FEATURES, getFeatureById } from "./features.js";
import type { GuardSettings } from "./types.js";
import { buildInspectReport } from "./inspect.js";
import { getSkillMap, refreshSkills, buildSkillStatus } from "./skills.js";

function formatMenuItem(id: string, label: string, enabled: boolean): string {
  return `${enabled ? "● ON " : "○ OFF"}  ${id.padEnd(15)} — ${label}`;
}

function parseIdFromMenuItem(item: string): string | undefined {
  const match = item.match(/^[●○]\s+(?:ON|OFF)\s+(\S+)/);
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

export function buildStatusText(settings: GuardSettings): string {
  const lines: string[] = [];
  lines.push("=== Context Guard ===\n");

  lines.push("[Prompt rules]");
  for (const f of MANAGED_FEATURES.filter((f) => f.category === "prompt")) {
    const enabled = settings.promptRules[f.id] ?? f.defaultEnabled;
    lines.push(`  ${enabled ? "✓" : "✗"} ${f.label}`);
  }

  lines.push("\n[Tool gates]");
  for (const f of MANAGED_FEATURES.filter((f) => f.category === "tools")) {
    const enabled = settings.features[f.id] ?? f.defaultEnabled;
    lines.push(`  ${enabled ? "✓" : "✗"} ${f.label}`);
  }

  lines.push("\n[Skills]");
  lines.push(`  ${settings.autoSkills !== false ? "✓" : "✗"} Automatic skill injection`);

  lines.push("\nCommands:");
  lines.push("  /context-guard         interactive TUI (inspect, overview, dumps, rules, gates, skills)");
  lines.push("  /context-guard <id>    toggle a feature");
  lines.push("  /context-guard reset   disable all guards");
  lines.push("  /use-skill <name>      inject a skill manually");

  return lines.join("\n");
}

export async function runGuardTUI(ctx: ExtensionCommandContext, pi: ExtensionAPI, deps: TUIDeps) {
  const mainOptions = [
    "🎛  Prompt rules",
    "🔧 Tool gates",
    "📦 Skills",
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
      await ctx.ui.editor("ctx-inspect", report);
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
      const confirmed = await ctx.ui.confirm("Reset all guards?", "This will disable every context guard rule and tool gate.");
      if (confirmed) {
        deps.settings = {
          promptRules: {},
          features: {},
          autoSkills: true,
        };
        deps.saveSettings(deps.settings);
        deps.syncTools();
        ctx.ui.notify("All guards reset.", "info");
      }
      continue;
    }

    if (choice === "🎛  Prompt rules") {
      await runPromptRulesMenu(ctx, deps);
      continue;
    }

    if (choice === "🔧 Tool gates") {
      await runToolGatesMenu(ctx, deps);
      continue;
    }

    if (choice === "📦 Skills") {
      await runSkillsMenu(ctx, deps);
      continue;
    }
  }
}

async function runPromptRulesMenu(ctx: ExtensionCommandContext, deps: TUIDeps) {
  const rules = MANAGED_FEATURES.filter((f) => f.category === "prompt");

  while (true) {
    const options = rules.map((f) =>
      formatMenuItem(f.id, f.label, deps.settings.promptRules[f.id] ?? f.defaultEnabled),
    );
    options.push("", "← Back");

    const choice = await ctx.ui.select("Prompt rules", options);
    if (!choice || choice === "← Back") return;

    const id = parseIdFromMenuItem(choice);
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

    const choice = await ctx.ui.select("Tool gates", options);
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
      formatMenuItem("autoSkills", "Automatic skill injection", autoEnabled),
      "",
      "📋 List discovered skills",
      "← Back",
    ];

    const choice = await ctx.ui.select("Skills", options);
    if (!choice || choice === "← Back") return;

    if (choice === "📋 List discovered skills") {
      const text = buildSkillStatus(deps.settings.autoSkills !== false);
      await ctx.ui.editor("skills", text);
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
