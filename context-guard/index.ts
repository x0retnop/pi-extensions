import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGuardSettings, saveGuardSettings } from "./config.js";
import { MANAGED_FEATURES, getFeatureById } from "./features.js";
import { applyPromptRules } from "./prompt-rules.js";
import { syncToolGates } from "./tool-gates.js";
import { ensureSkillsDiscovered, removeSkillsBlock, injectPendingSkills, registerSkillCommands } from "./skills.js";
import { registerContextOverview } from "./overview.js";
import { buildInspectReport } from "./inspect.js";
import { runGuardTUI, buildStatusText } from "./tui.js";
import type { GuardSettings, PromptRuleContext } from "./types.js";

const EXT = "context-guard";

export default function (pi: ExtensionAPI) {
  let settings = loadGuardSettings();

  function syncTools() {
    syncToolGates(pi, settings.features);
  }

  pi.on("session_start", (_event, ctx) => {
    settings = loadGuardSettings();
    ensureSkillsDiscovered(ctx.cwd);
    syncTools();
  });

  pi.on("session_tree", () => {
    settings = loadGuardSettings();
    syncTools();
  });

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

  // Commands
  registerSkillCommands(pi);
  registerContextOverview(pi);

  pi.registerCommand("ctx-inspect", {
    description: "Inspect system prompt layers, auto-injections and guard rules",
    handler: async (_args, ctx) => {
      const prompt = (ctx as any).getSystemPrompt?.() ?? "";
      const options = (ctx as any).getSystemPromptOptions?.() ?? {};
      const entries = (ctx as any).sessionManager?.getEntries?.() ?? [];
      const report = buildInspectReport(prompt, options, settings, entries);

      if (!ctx.hasUI) {
        console.log(report);
        return;
      }
      await ctx.ui.editor("ctx-inspect", report);
    },
  });

  pi.registerCommand("ctx-guard", {
    description:
      "Open the Context Guard TUI, or toggle a feature directly. Features: " +
      MANAGED_FEATURES.map((f) => f.id).join(", ") +
      ", autoSkills",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const ids = [...MANAGED_FEATURES.map((f) => f.id), "autoSkills"];

      if (!arg || arg.toLowerCase() === "status") {
        if (ctx.hasUI) {
          await runGuardTUI(ctx, {
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
        settings = { promptRules: {}, features: {}, autoSkills: true };
        saveGuardSettings(settings);
        syncTools();
        const msg = "All context guards reset (disabled).";
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
}
