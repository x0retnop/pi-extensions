import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompressorSettings, CompressorState, CompressorTUIDeps } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

function formatOnOff(enabled: boolean): string {
  return enabled ? "● ON" : "○ OFF";
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
}

export function buildStatusText(settings: CompressorSettings, state: CompressorState, prompts: string[]): string {
  const lines: string[] = [];
  lines.push("=== Context Compressor ===\n");
  lines.push(`Enabled:        ${formatOnOff(settings.enabled)}`);
  lines.push(`Mode:           ${settings.mode}`);
  lines.push(`Prompt:         ${settings.promptName}`);
  lines.push(`Prompts avail:  ${prompts.join(", ") || "none"}`);
  lines.push(`Token threshold:${settings.tokenThresholdPercent}%`);
  lines.push(`Step interval:  ${settings.stepInterval}`);
  lines.push(`Min messages:   ${settings.minMessagesToSummarize}`);
  lines.push(`Max summary:    ${settings.maxSummaryTokens} tokens`);
  lines.push(`Trim context:   ${formatOnOff(settings.trimAfterCompress)}`);
  lines.push(`Kept messages:  ${settings.keptRecentMessages}`);
  lines.push(`Debug logging:  ${formatOnOff(settings.debug)}`);
  lines.push("");
  lines.push(`Step counter:   ${state.stepCounter}`);
  lines.push(`Last compress:  ${formatTimestamp(state.lastCompressionAt)}`);
  lines.push(`Failures:       ${state.consecutiveFailures}`);
  lines.push(`Key facts:      ${state.keyFacts ? `${state.keyFacts.length} chars` : "none"}`);
  lines.push("");
  lines.push("Commands:");
  lines.push("  /context-compressor       interactive TUI");
  lines.push("  /context-compressor status  print this status");
  return lines.join("\n");
}

export async function runCompressorTUI(ctx: ExtensionCommandContext, deps: CompressorTUIDeps): Promise<void> {
  while (true) {
    const menu = [
      `${formatOnOff(deps.settings.enabled)} Toggle enabled`,
      `Prompt: ${deps.settings.promptName}`,
      `Mode: ${deps.settings.mode}`,
      `Token threshold: ${deps.settings.tokenThresholdPercent}%`,
      `Step interval: ${deps.settings.stepInterval}`,
      `Min messages: ${deps.settings.minMessagesToSummarize}`,
      `Max summary tokens: ${deps.settings.maxSummaryTokens}`,
      `${formatOnOff(deps.settings.trimAfterCompress)} Trim after compress`,
      `Kept messages: ${deps.settings.keptRecentMessages}`,
      `${formatOnOff(deps.settings.debug)} Debug logging`,
      "⚡ Force summary now",
      "📋 View current KEY FACTS",
      "↺ Reset to defaults",
      "✓ Done",
    ];

    const choice = await ctx.ui.select("Context Compressor", menu);
    if (!choice || choice === "✓ Done") return;

    if (choice.includes("Toggle enabled")) {
      deps.settings = { ...deps.settings, enabled: !deps.settings.enabled };
      deps.saveSettings(deps.settings);
      ctx.ui.notify(`Context compressor ${deps.settings.enabled ? "enabled" : "disabled"}`, "info");
      continue;
    }

    if (choice.includes("Prompt:")) {
      const prompts = deps.listPrompts();
      if (prompts.length === 0) {
        ctx.ui.notify("No prompt files found next to index.ts", "error");
        continue;
      }
      const selected = await ctx.ui.select("Select summary prompt", prompts);
      if (selected) {
        deps.settings = { ...deps.settings, promptName: selected };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Prompt → ${selected}`, "info");
      }
      continue;
    }

    if (choice.includes("Mode:")) {
      const mode = await ctx.ui.select("Select mode", ["auto", "manual"]);
      if (mode === "auto" || mode === "manual") {
        deps.settings = { ...deps.settings, mode };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Mode → ${mode}`, "info");
      }
      continue;
    }

    if (choice.includes("Token threshold:")) {
      const raw = await ctx.ui.input("Token threshold (% of context window)", String(deps.settings.tokenThresholdPercent));
      const num = parseInt(raw ?? "", 10);
      if (!Number.isNaN(num)) {
        deps.settings = { ...deps.settings, tokenThresholdPercent: clamp(num, 10, 95) };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Token threshold → ${deps.settings.tokenThresholdPercent}%`, "info");
      }
      continue;
    }

    if (choice.includes("Step interval:")) {
      const raw = await ctx.ui.input("Step interval (LLM calls)", String(deps.settings.stepInterval));
      const num = parseInt(raw ?? "", 10);
      if (!Number.isNaN(num)) {
        deps.settings = { ...deps.settings, stepInterval: clamp(num, 1, 1000) };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Step interval → ${deps.settings.stepInterval}`, "info");
      }
      continue;
    }

    if (choice.includes("Min messages:")) {
      const raw = await ctx.ui.input("Min messages before summarizing", String(deps.settings.minMessagesToSummarize));
      const num = parseInt(raw ?? "", 10);
      if (!Number.isNaN(num)) {
        deps.settings = { ...deps.settings, minMessagesToSummarize: clamp(num, 2, 200) };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Min messages → ${deps.settings.minMessagesToSummarize}`, "info");
      }
      continue;
    }

    if (choice.includes("Max summary tokens:")) {
      const raw = await ctx.ui.input("Max summary output tokens", String(deps.settings.maxSummaryTokens));
      const num = parseInt(raw ?? "", 10);
      if (!Number.isNaN(num)) {
        deps.settings = { ...deps.settings, maxSummaryTokens: clamp(num, 200, 8000) };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Max summary tokens → ${deps.settings.maxSummaryTokens}`, "info");
      }
      continue;
    }

    if (choice.includes("Trim after compress")) {
      deps.settings = { ...deps.settings, trimAfterCompress: !deps.settings.trimAfterCompress };
      deps.saveSettings(deps.settings);
      ctx.ui.notify(`Trim after compress → ${deps.settings.trimAfterCompress ? "ON" : "OFF"}`, "info");
      continue;
    }

    if (choice.includes("Kept messages:")) {
      const raw = await ctx.ui.input("Messages to keep when trimming", String(deps.settings.keptRecentMessages));
      const num = parseInt(raw ?? "", 10);
      if (!Number.isNaN(num)) {
        deps.settings = { ...deps.settings, keptRecentMessages: clamp(num, 2, 100) };
        deps.saveSettings(deps.settings);
        ctx.ui.notify(`Kept messages → ${deps.settings.keptRecentMessages}`, "info");
      }
      continue;
    }

    if (choice.includes("Debug logging")) {
      deps.settings = { ...deps.settings, debug: !deps.settings.debug };
      deps.saveSettings(deps.settings);
      ctx.ui.notify(`Debug logging → ${deps.settings.debug ? "ON" : "OFF"}`, "info");
      continue;
    }

    if (choice.includes("Force summary now")) {
      ctx.ui.setWorkingMessage("Summarizing context...");
      try {
        await deps.forceSummary(ctx);
        if (deps.state.keyFacts) {
          ctx.ui.notify(`Summary created (${deps.state.keyFacts.length} chars)`, "info");
        } else if (deps.state.consecutiveFailures > 0) {
          ctx.ui.notify("Summary failed. Check debug logs.", "error");
        } else {
          ctx.ui.notify("No summary generated", "warning");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Summary failed: ${msg}`, "error");
      } finally {
        ctx.ui.setWorkingMessage();
      }
      continue;
    }

    if (choice.includes("View current KEY FACTS")) {
      const text = deps.state.keyFacts || "No KEY FACTS available yet.";
      await ctx.ui.editor("context-compressor-key-facts", text);
      continue;
    }

    if (choice.includes("Reset to defaults")) {
      const ok = await ctx.ui.confirm("Reset settings?", "Restore all context compressor defaults.");
      if (ok) {
        deps.settings = { ...DEFAULT_SETTINGS };
        deps.saveSettings(deps.settings);
        ctx.ui.notify("Settings reset to defaults", "info");
      }
      continue;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
