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
      ctx.ui.setStatus(EXT, settings.enabled ? `cc: ${settings.mode}` : "cc: off");
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

    try {
      if (shouldTrigger(ctx, event.messages, state, settings)) {
        await compressContext(ctx, settings, state);
      }
    } catch (err) {
      if (settings.debug) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${EXT}] context handler error: ${msg}`);
      }
    }

    let messages = injectKeyFacts(event.messages, state);
    if (settings.trimAfterCompress) {
      messages = trimMessages(messages, settings.keptRecentMessages);
    }

    if (messages !== event.messages) {
      return { messages };
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
        ctx.ui.setStatus(EXT, settings.enabled ? `cc: ${settings.mode}` : "cc: off");
      }
    },
  });

  // Validate on load: warn if the configured prompt is missing.
  const initialPrompt = loadPrompt(resolvePromptName(settings));
  if (!initialPrompt && settings.enabled) {
    console.warn(`[${EXT}] configured prompt "${settings.promptName}" not found next to index.ts`);
  }
}
