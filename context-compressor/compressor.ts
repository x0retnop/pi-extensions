import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import type { CompressorSettings, CompressorState } from "./types.js";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));
const KEY_FACTS_MARKER = "**KEY FACTS**";

export function listPromptFiles(): string[] {
  if (!existsSync(PROMPTS_DIR)) return [];
  try {
    return readdirSync(PROMPTS_DIR)
      .filter((f) => f.startsWith("prompt-") && f.endsWith(".txt"))
      .map((f) => f.slice("prompt-".length, -".txt".length))
      .sort();
  } catch {
    return [];
  }
}

export function loadPrompt(name: string): string | null {
  const path = join(PROMPTS_DIR, `prompt-${name}.txt`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function resolvePromptName(settings: CompressorSettings): string {
  const available = listPromptFiles();
  if (available.includes(settings.promptName)) return settings.promptName;
  if (available.length > 0) return available[0];
  return settings.promptName;
}

export function buildTranscript(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as any;
  const { messages } = sm.buildSessionContext();
  const llmMessages = convertToLlm(messages);
  return serializeConversation(llmMessages);
}

export function shouldTrigger(
  ctx: ExtensionContext,
  eventMessages: any[],
  state: CompressorState,
  settings: CompressorSettings,
): { trigger: boolean; reason: "token" | "step" | null } {
  if (!settings.enabled || settings.mode !== "auto" || state.isCompressing) {
    return { trigger: false, reason: null };
  }
  if (eventMessages.length < settings.minMessagesToSummarize) {
    return { trigger: false, reason: null };
  }

  const stepsSinceLast = state.stepCounter - state.lastCompressionStep;
  if (stepsSinceLast < 2) {
    return { trigger: false, reason: null };
  }

  const usage = ctx.getContextUsage();
  if (usage?.percent !== null && usage.percent >= settings.tokenThresholdPercent) {
    return { trigger: true, reason: "token" };
  }
  if (stepsSinceLast >= settings.stepInterval) {
    return { trigger: true, reason: "step" };
  }
  return { trigger: false, reason: null };
}

export async function compressContext(
  ctx: ExtensionContext,
  settings: CompressorSettings,
  state: CompressorState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state.isCompressing) {
    return { ok: true };
  }
  state.isCompressing = true;

  try {
    const model = ctx.model;
    if (!model) {
      throw new Error("No active model");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) {
      throw new Error(auth.error || "Model auth not configured");
    }

    const promptName = resolvePromptName(settings);
    const prompt = loadPrompt(promptName);
    if (!prompt) {
      throw new Error(`Prompt "${promptName}" not found in ${PROMPTS_DIR}`);
    }

    const transcript = buildTranscript(ctx);
    if (transcript.trim().length === 0) {
      throw new Error("No conversation history to summarize");
    }

    const fittedTranscript = fitTranscript(transcript, model.contextWindow, settings.maxSummaryTokens);
    if (fittedTranscript.length < 200) {
      throw new Error("Transcript too short after fitting");
    }

    const systemPrompt = `${prompt}\n\n<conversation_history>\n${fittedTranscript}\n</conversation_history>`;

    const summary = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: "Produce the KEY FACTS summary now. Output only the structured KEY FACTS block.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: settings.maxSummaryTokens,
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ctx.signal,
      },
    );

    if (summary.stopReason === "error" || summary.stopReason === "aborted") {
      throw new Error(summary.errorMessage || "Summary generation failed");
    }

    const text = summary.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Summary output was empty");
    }

    const keyFacts = extractKeyFacts(text);
    if (!keyFacts) {
      throw new Error("Could not extract KEY FACTS block from summary");
    }

    state.keyFacts = keyFacts;
    state.lastCompressionStep = state.stepCounter;
    state.lastCompressionEntryCount = ctx.sessionManager.getBranch().length;
    state.lastCompressionAt = Date.now();
    state.consecutiveFailures = 0;

    if (settings.debug) {
      console.error(`[context-compressor] summarized with "${promptName}" (${fittedTranscript.length} chars) -> ${keyFacts.length} chars`);
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.consecutiveFailures++;
    if (settings.debug) {
      console.error(`[context-compressor] compression failed: ${msg}`);
    }
    // Keep any previous keyFacts as fallback; do not clear.
    return { ok: false, error: msg };
  } finally {
    state.isCompressing = false;
  }
}

export function injectKeyFacts(messages: any[], state: CompressorState): any[] {
  if (!state.keyFacts) return messages;

  const injection = {
    role: "custom",
    customType: "context-compressor",
    content: `[CONTEXT COMPRESSOR — KEY FACTS]\n\n${state.keyFacts}`,
    display: false,
    timestamp: Date.now(),
  };

  return [injection, ...messages];
}

export function trimMessages(messages: any[], keep: number): any[] {
  if (messages.length <= keep) return messages;
  const trimmed = messages.slice(-keep);
  // Trimming in the middle of a tool-call block leaves orphaned toolResult
  // messages and causes provider errors. If the trim is unsafe, keep the full
  // context instead.
  if (!isToolContextValid(trimmed)) {
    return messages;
  }
  return trimmed;
}

function isToolContextValid(messages: any[]): boolean {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "toolCall" && c.id) {
          toolCallIds.add(c.id);
        }
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      toolResultIds.add(m.toolCallId);
    }
  }
  for (const id of toolResultIds) {
    if (!toolCallIds.has(id)) return false;
  }
  for (const id of toolCallIds) {
    if (!toolResultIds.has(id)) return false;
  }
  return true;
}

export function fitTranscript(transcript: string, contextWindow: number, maxSummaryTokens: number): string {
  // Reserve output + prompt + user message + overhead.
  const promptOverheadTokens = 1200;
  const availableTokens = Math.floor(contextWindow * 0.65) - maxSummaryTokens - promptOverheadTokens;
  if (availableTokens <= 0) return "";

  const maxChars = availableTokens * 4;
  if (transcript.length <= maxChars) return transcript;

  const marker = "[... earlier conversation truncated ...]\n\n";
  const keepChars = Math.max(0, maxChars - marker.length);
  const tail = transcript.slice(-keepChars);
  const cleanTail = tail.replace(/^\s*[\s\S]*?\n\n/, ""); // avoid starting mid-line
  return marker + cleanTail;
}

export function extractKeyFacts(raw: string): string | null {
  const idx = raw.indexOf(KEY_FACTS_MARKER);
  if (idx >= 0) {
    return raw.slice(idx).trim();
  }
  // Fallback: if output has no marker but has structured bullets, keep it.
  if (raw.includes("-") || raw.includes("*")) {
    return `${KEY_FACTS_MARKER}\n\n${raw}`;
  }
  return null;
}
