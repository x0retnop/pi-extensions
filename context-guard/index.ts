import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGuardSettings, saveGuardSettings } from "./config.js";
import { MANAGED_FEATURES, getFeatureById } from "./features.js";
import { applyPromptRules } from "./prompt-rules.js";
import { syncToolGates } from "./tool-gates.js";
import { ensureSkillsDiscovered, removeSkillsBlock, injectPendingSkills, registerUseSkillCommand } from "./skills.js";
import { runGuardTUI, buildStatusText } from "./tui.js";
import { startDumpCapture } from "./dump.js";
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

  // Capture live context for full dump.
  startDumpCapture(pi);

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
      ", autoSkills, reset",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const ids = [...MANAGED_FEATURES.map((f) => f.id), "autoSkills"];

      if (!arg || arg.toLowerCase() === "status") {
        if (ctx.hasUI) {
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

  // Register skill quick command.
  registerUseSkillCommand(pi);
}
