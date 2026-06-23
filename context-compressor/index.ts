import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, saveSettings } from "./config.js";
import { createState, type CompressorSettings, type CompressorState } from "./types.js";
import {
  compressContext,
  injectKeyFacts,
  listPromptFiles,
  loadPrompt,
  resolvePromptName,
  shouldTrigger,
  trimMessages,
} from "./compressor.js";
import { buildStatusText, runCompressorTUI } from "./tui.js";

const EXT = "context-compressor";
const SUMMARY_EVENT_TYPE = "context-compressor-summary";

function formatTimeShort(ts: number | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatStatusText(settings: CompressorSettings, state: CompressorState): string {
  if (!settings.enabled) return "cc: off";
  const base = `cc: ${settings.mode}`;
  if (state.consecutiveFailures > 0) {
    return `${base} | fail`;
  }
  if (state.keyFacts && state.lastCompressionAt) {
    return `${base} | ${state.keyFacts.length.toLocaleString()} @ ${formatTimeShort(state.lastCompressionAt)}`;
  }
  return base;
}

function formatCompressionChat(state: CompressorState, reason: "token" | "step"): string {
  const size = state.keyFacts ? `${state.keyFacts.length.toLocaleString()} chars` : "generated";
  const when = formatTimeShort(state.lastCompressionAt);
  const reasonText = reason === "token" ? "context threshold" : "step interval";
  return `[Context Compressor] Summary ${size} at ${when} (trigger: ${reasonText}, step ${state.stepCounter})`;
}

function formatFailureChat(error: string): string {
  return `[Context Compressor] Summary failed at ${formatTimeShort(Date.now())}: ${error}`;
}

export default function contextCompressorExtension(pi: ExtensionAPI) {
  let settings = loadSettings();
  let state: CompressorState = createState();

  function persist(s: CompressorSettings) {
    settings = s;
    saveSettings(s);
  }

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings();
    state = createState();
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXT, formatStatusText(settings, state));
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    // Avoid immediate re-trigger after built-in compaction; keep existing keyFacts.
    state.lastCompressionStep = state.stepCounter;
    state.lastCompressionEntryCount = ctx.sessionManager.getBranch().length;
  });

  pi.on("context", async (event, ctx) => {
    if (!settings.enabled) return undefined;

    state.stepCounter++;

    // Visible summary markers are for the user only; keep them out of the LLM context.
    const messages = event.messages.filter(
      (m: any) => !(m.role === "custom" && m.customType === SUMMARY_EVENT_TYPE),
    );

    try {
      const { trigger, reason } = shouldTrigger(ctx, messages, state, settings);
      if (trigger && reason) {
        const result = await compressContext(ctx, settings, state);
        if (ctx.hasUI) {
          ctx.ui.setStatus(EXT, formatStatusText(settings, state));
          if ("error" in result) {
            pi.sendMessage(
              {
                customType: SUMMARY_EVENT_TYPE,
                content: formatFailureChat(result.error),
                display: true,
              },
              { triggerTurn: false },
            );
          } else {
            pi.sendMessage(
              {
                customType: SUMMARY_EVENT_TYPE,
                content: formatCompressionChat(state, reason),
                display: true,
              },
              { triggerTurn: false },
            );
          }
        }
      }
    } catch (err) {
      if (settings.debug) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${EXT}] context handler error: ${msg}`);
      }
    }

    let processed = injectKeyFacts(messages, state);
    if (settings.trimAfterCompress) {
      processed = trimMessages(processed, settings.keptRecentMessages);
    }

    const changed =
      processed.length !== event.messages.length ||
      processed.some((m, i) => m !== event.messages[i]);

    if (changed) {
      return { messages: processed };
    }
    return undefined;
  });

  async function forceSummary(ctx: ExtensionContext): Promise<void> {
    const messages = (ctx.sessionManager as any).buildSessionContext().messages;
    if (messages.length < settings.minMessagesToSummarize) {
      throw new Error(`Need at least ${settings.minMessagesToSummarize} messages to summarize (have ${messages.length})`);
    }
    await compressContext(ctx, settings, state);
    state.lastCompressionEntryCount = ctx.sessionManager.getBranch().length;
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXT, formatStatusText(settings, state));
    }
  }

  pi.registerCommand(EXT, {
    description: "Open the Context Compressor TUI (status, force summary, settings).",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "status" || !ctx.hasUI) {
        const text = buildStatusText(settings, state, listPromptFiles());
        if (ctx.hasUI) {
          ctx.ui.notify(text, "info");
        } else {
          console.log(text);
        }
        return;
      }

      await runCompressorTUI(ctx, {
        settings,
        saveSettings: persist,
        state,
        forceSummary,
        listPrompts: listPromptFiles,
      });

      if (ctx.hasUI) {
        ctx.ui.setStatus(EXT, formatStatusText(settings, state));
      }
    },
  });

  // Validate on load: warn if the configured prompt is missing.
  const initialPrompt = loadPrompt(resolvePromptName(settings));
  if (!initialPrompt && settings.enabled) {
    console.warn(`[${EXT}] configured prompt "${settings.promptName}" not found next to index.ts`);
  }
}
