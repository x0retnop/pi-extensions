/**
 * Handoff Extension
 *
 * Provides a `/handoff` command that generates a high-quality "new thread prompt"
 * from the current session, then starts a new session with that prompt pre-filled
 * for the user to review and send.
 *
 * Usage:
 *   /handoff implement team-level handoff with proper tests
 *   /handoff fix the authentication bug in login flow
 *   /handoff add unit tests for the parser module
 */

import {
  complete,
  getModel,
  type Api,
  type Message,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

import { loadConfig, validateGoal } from "./config.js";
import { ProgressLoader, EXTRACTION_PHASES } from "./progress.js";
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_RETRY_PROMPT,
  buildExtractionUserMessage,
  processExtractionResponse,
  extractTextFromAssistantMessage,
} from "./extraction.js";
import { collectSessionMetadata } from "./metadata.js";
import { assembleHandoffPrompt } from "./prompt.js";
import {
  SKILL_ENTRY_TYPE,
  type HandoffConfig,
  type SkillEntry,
} from "./types.js";

type ModelRegistry = ExtensionCommandContext["modelRegistry"];
type RequestAuth = Pick<ProviderStreamOptions, "apiKey" | "headers">;

const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EXTRACTION_CONVERSATION_CHARS = 160_000;
const EXTRACTION_HEAD_CHARS = 12_000;
const CONTEXT_WARN_PERCENT = 60;
const MESSAGE_WARN_COUNT = 80;

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notify(ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level: string) => void } }, message: string, level = "info"): void {
  const text = `[handoff] ${message}`;
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(text, level);
    return;
  }
  const log = level === "error" ? console.error : console.log;
  log(text);
}

function maybeWarnLargeContext(ctx: ExtensionCommandContext, messageCount: number): void {
  let percent = ctx.getContextUsage()?.percent;
  if (percent === null || percent === undefined) {
    const usage = ctx.getContextUsage();
    percent = usage?.tokens && usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow) * 100 : undefined;
  }

  const reasons: string[] = [];
  if (typeof percent === "number" && percent >= CONTEXT_WARN_PERCENT) reasons.push(`${percent.toFixed(0)}% context`);
  if (messageCount >= MESSAGE_WARN_COUNT) reasons.push(`${messageCount} messages`);
  if (reasons.length > 0) {
    notify(ctx, `large session (${reasons.join(", ")}); handoff extraction will use a bounded context slice`, "warning");
  }
}

function limitConversationText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTION_CONVERSATION_CHARS) return { text, truncated: false };

  const head = text.slice(0, EXTRACTION_HEAD_CHARS);
  const tailBudget = Math.max(0, MAX_EXTRACTION_CONVERSATION_CHARS - EXTRACTION_HEAD_CHARS);
  const tail = text.slice(-tailBudget);
  const omitted = text.length - head.length - tail.length;

  return {
    text: `${head}\n\n[handoff: ${omitted.toLocaleString()} chars omitted from the middle of a large session]\n\n${tail}`,
    truncated: true,
  };
}

function makeAbortSignal(parent: AbortSignal | undefined): { signal: AbortSignal; abort: (reason?: unknown) => void; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);

  if (parent) {
    if (parent.aborted) abortFromParent();
    else parent.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    abort: (reason?: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    cleanup: () => parent?.removeEventListener("abort", abortFromParent),
  };
}

async function getRequestAuth(
  modelRegistry: ModelRegistry,
  model: Model<Api>,
): Promise<RequestAuth> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return {};

  return {
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers ? { headers: auth.headers } : {}),
  };
}

function normalizeSkillCommandName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

function getInvokedSkillName(input: string, pi: ExtensionAPI): string | undefined {
  const match = input.trim().match(/^\/([^\s]+)/);
  if (!match) return undefined;

  const invoked = match[1];
  if (invoked.startsWith("skill:")) {
    return normalizeSkillCommandName(invoked);
  }

  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    if (command.name === invoked) {
      return normalizeSkillCommandName(command.name);
    }
  }

  return undefined;
}

/**
 * Resolves the model to use for extraction based on config
 */
function resolveExtractionModel(
  ctx: ExtensionCommandContext,
  config: HandoffConfig,
): Model<any> | undefined {
  // Use current model if configured to do so or no override specified
  if (config.useCurrentModel || !config.model) {
    return ctx.model;
  }

  // Try to get the override model
  const [provider, ...modelParts] = config.model.split("/");
  const modelId = modelParts.join("/");

  if (!provider || !modelId) {
    // Invalid format, fall back to current
    return ctx.model;
  }

  const overrideModel = getModel(provider as any, modelId);
  if (!overrideModel) {
    // Model not found, fall back to current
    console.warn(`[handoff] Model ${config.model} not found, using current model`);
    return ctx.model;
  }

  return overrideModel;
}

/**
 * Main handoff command handler
 */
async function runHandoffCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  lastSkill: string | undefined,
): Promise<void> {
  // Load config from .pi/settings.json
  const cwd = ctx.sessionManager.getCwd();
  const config = loadConfig(cwd);

  // Validate goal
  const goal = args?.trim() ?? "";
  const goalValidation = validateGoal(goal, config.minGoalLength);

  if (!goalValidation.valid) {
    notify(ctx, goalValidation.error!, "error");
    return;
  }

  // Check for model
  if (!ctx.model) {
    notify(ctx, "No model selected. Use /model to select a model first.", "error");
    return;
  }

  // Get conversation context
  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  const messages = sessionContext.messages;
  maybeWarnLargeContext(ctx, messages.length);

  if (messages.length === 0) {
    notify(ctx, "No conversation to hand off.", "error");
    return;
  }

  // Convert messages to LLM format and serialize
  const llmMessages = convertToLlm(messages);
  const limitedConversation = limitConversationText(serializeConversation(llmMessages));
  if (limitedConversation.truncated) {
    notify(ctx, "session context is very large; using beginning + recent tail for extraction", "warning");
  }
  const conversationText = limitedConversation.text;
  const currentSessionFile = ctx.sessionManager.getSessionFile();

  // Collect metadata
  const activeTools = pi.getActiveTools();
  const sessionName = ctx.sessionManager.getSessionName();
  const thinkingLevel = pi.getThinkingLevel();

  const metadata = await collectSessionMetadata({
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: thinkingLevel !== "off" ? thinkingLevel : undefined,
    tools: activeTools,
    sessionName: sessionName ?? undefined,
    lastSkill,
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
  });

  // Resolve which model to use for extraction
  const extractionModel = resolveExtractionModel(ctx, config);
  if (!extractionModel) {
    notify(ctx, "No model available for extraction.", "error");
    return;
  }

  // Generate extraction via LLM
  const extractionResult = await generateExtraction(
    conversationText,
    goal,
    config,
    ctx,
    extractionModel,
  );

  if (!extractionResult.success || !extractionResult.extraction) {
    notify(ctx, extractionResult.error ?? "Failed to generate handoff context", "error");
    return;
  }

  // Assemble the handoff prompt
  const handoffPrompt = assembleHandoffPrompt(
    extractionResult.extraction,
    goal,
    metadata,
    config,
  );

  // Non-UI mode: just print the prompt
  if (!ctx.hasUI) {
    console.log(handoffPrompt);
    return;
  }

  // Interactive mode: let user edit the prompt
  const editedPrompt = await ctx.ui.editor("Edit handoff prompt", handoffPrompt);

  if (editedPrompt === undefined) {
    notify(ctx, "cancelled", "info");
    return;
  }

  // Create new session with parent tracking.
  // Any post-session-replacement work must happen inside withSession,
  // using the fresh ctx passed by Pi.
  const newSessionResult = await ctx.newSession({
    parentSession: currentSessionFile,
    withSession: async (newCtx) => {
      newCtx.ui.setEditorText(editedPrompt);
      newCtx.ui.notify("Handoff ready. Press Enter to send.", "info");
    },
  });

  if (newSessionResult.cancelled) {
    notify(ctx, "new session cancelled", "info");
    return;
  }
}

/**
 * Extraction result type
 */
interface ExtractionResult {
  success: boolean;
  extraction?: ReturnType<typeof processExtractionResponse>["normalized"];
  error?: string;
  completionMessage?: string;
}

/**
 * Generates the extraction by calling the LLM with retry on parse failure
 */
async function generateExtraction(
  conversationText: string,
  goal: string,
  config: HandoffConfig,
  ctx: ExtensionCommandContext,
  model: Model<any>,
): Promise<ExtractionResult> {
  if (!ctx.hasUI) {
    // Non-UI mode: direct call without loader
    try {
      return await doExtraction(conversationText, goal, config, ctx, model);
    } catch (err) {
      return { success: false, error: formatError(err) };
    }
  }

  // Interactive mode: show loader during extraction
  if (config.showProgressPhases) {
    // Use phase-based progress loader
    return await ctx.ui.custom<ExtractionResult>((tui, theme, _kb, done) => {
      const loader = new ProgressLoader(tui, theme, EXTRACTION_PHASES[0]);
      const abort = makeAbortSignal(loader.signal);
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (result: ExtractionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        abort.cleanup();
        loader.dispose();
        done(result);
      };
      timeout = setTimeout(() => {
        abort.abort(new Error("Extraction timed out"));
        finish({ success: false, error: "Extraction timed out" });
      }, EXTRACTION_TIMEOUT_MS);

      loader.onAbort = () => {
        abort.abort(new Error("Cancelled"));
        finish({ success: false, error: "Cancelled" });
      };

      doExtractionWithPhases(conversationText, goal, config, ctx, model, abort.signal, (phase) => {
        if (!settled) loader.setPhase(phase);
      })
        .then((result) => {
          const completionMessage = loader.getCompletionMessage();
          finish({ ...result, completionMessage });
        })
        .catch((err) => {
          console.error("[handoff] extraction failed:", err);
          finish({ success: false, error: formatError(err) });
        });

      return loader;
    });
  } else {
    // Use simple bordered loader
    return await ctx.ui.custom<ExtractionResult>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Generating handoff context...");
      const abort = makeAbortSignal(loader.signal);
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (result: ExtractionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        abort.cleanup();
        (loader as any).dispose?.();
        done(result);
      };
      timeout = setTimeout(() => {
        abort.abort(new Error("Extraction timed out"));
        finish({ success: false, error: "Extraction timed out" });
      }, EXTRACTION_TIMEOUT_MS);

      loader.onAbort = () => {
        abort.abort(new Error("Cancelled"));
        finish({ success: false, error: "Cancelled" });
      };

      doExtraction(conversationText, goal, config, ctx, model, abort.signal)
        .then(finish)
        .catch((err) => {
          console.error("[handoff] extraction failed:", err);
          finish({ success: false, error: formatError(err) });
        });

      return loader;
    });
  }
}

/**
 * Performs the actual LLM extraction call with retry
 */
async function doExtraction(
  conversationText: string,
  goal: string,
  config: HandoffConfig,
  ctx: ExtensionCommandContext,
  model: Model<any>,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const requestAuth = await getRequestAuth(ctx.modelRegistry, model);

  // Build user message
  const userMessage: Message = {
    role: "user",
    content: [
      { type: "text", text: buildExtractionUserMessage(conversationText, goal) },
    ],
    timestamp: Date.now(),
  };

  // First attempt
  const response = await complete(
    model,
    { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
    { ...requestAuth, signal },
  );

  if (response.stopReason === "aborted") {
    return { success: false, error: "Cancelled" };
  }

  if (response.stopReason === "error") {
    return { success: false, error: response.errorMessage ?? "LLM error" };
  }

  const responseText = extractTextFromAssistantMessage(response.content);
  const result = processExtractionResponse(responseText, config, conversationText);

  if (result.success && result.normalized) {
    return { success: true, extraction: result.normalized };
  }

  // Retry with stricter prompt
  const retryMessage: Message = {
    role: "user",
    content: [{ type: "text", text: EXTRACTION_RETRY_PROMPT }],
    timestamp: Date.now(),
  };

  const assistantMessage: Message = {
    role: "assistant",
    content: response.content,
    api: response.api,
    provider: response.provider,
    model: response.model,
    usage: response.usage,
    stopReason: response.stopReason,
    timestamp: response.timestamp,
  };

  const retryResponse = await complete(
    model,
    {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [userMessage, assistantMessage, retryMessage],
    },
    { ...requestAuth, signal },
  );

  if (retryResponse.stopReason === "aborted") {
    return { success: false, error: "Cancelled" };
  }

  if (retryResponse.stopReason === "error") {
    return { success: false, error: retryResponse.errorMessage ?? "LLM error on retry" };
  }

  const retryText = extractTextFromAssistantMessage(retryResponse.content);
  const retryResult = processExtractionResponse(retryText, config, conversationText);

  if (retryResult.success && retryResult.normalized) {
    return { success: true, extraction: retryResult.normalized };
  }

  return {
    success: false,
    error: `Failed to parse extraction after retry: ${retryResult.error}`,
  };
}

/**
 * Performs extraction with phase updates for progress UI
 */
async function doExtractionWithPhases(
  conversationText: string,
  goal: string,
  config: HandoffConfig,
  ctx: ExtensionCommandContext,
  model: Model<any>,
  signal: AbortSignal,
  onPhase: (phase: string) => void,
): Promise<ExtractionResult> {
  const requestAuth = await getRequestAuth(ctx.modelRegistry, model);

  // Phase 1: Analyzing conversation
  onPhase(EXTRACTION_PHASES[0]);

  // Build user message
  const userMessage: Message = {
    role: "user",
    content: [
      { type: "text", text: buildExtractionUserMessage(conversationText, goal) },
    ],
    timestamp: Date.now(),
  };

  // Phase 2: Extracting context (LLM call)
  onPhase(EXTRACTION_PHASES[1]);

  // First attempt
  const response = await complete(
    model,
    { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
    { ...requestAuth, signal },
  );

  if (response.stopReason === "aborted") {
    return { success: false, error: "Cancelled" };
  }

  if (response.stopReason === "error") {
    return { success: false, error: response.errorMessage ?? "LLM error" };
  }

  // Phase 3: Assembling prompt
  onPhase(EXTRACTION_PHASES[2]);

  const responseText = extractTextFromAssistantMessage(response.content);
  const result = processExtractionResponse(responseText, config, conversationText);

  if (result.success && result.normalized) {
    return { success: true, extraction: result.normalized };
  }

  // Retry needed - stay on phase 2
  onPhase("Retrying extraction...");

  const retryMessage: Message = {
    role: "user",
    content: [{ type: "text", text: EXTRACTION_RETRY_PROMPT }],
    timestamp: Date.now(),
  };

  const assistantMessage: Message = {
    role: "assistant",
    content: response.content,
    api: response.api,
    provider: response.provider,
    model: response.model,
    usage: response.usage,
    stopReason: response.stopReason,
    timestamp: response.timestamp,
  };

  const retryResponse = await complete(
    model,
    {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [userMessage, assistantMessage, retryMessage],
    },
    { ...requestAuth, signal },
  );

  if (retryResponse.stopReason === "aborted") {
    return { success: false, error: "Cancelled" };
  }

  if (retryResponse.stopReason === "error") {
    return { success: false, error: retryResponse.errorMessage ?? "LLM error on retry" };
  }

  // Back to phase 3
  onPhase(EXTRACTION_PHASES[2]);

  const retryText = extractTextFromAssistantMessage(retryResponse.content);
  const retryResult = processExtractionResponse(retryText, config, conversationText);

  if (retryResult.success && retryResult.normalized) {
    return { success: true, extraction: retryResult.normalized };
  }

  return {
    success: false,
    error: `Failed to parse extraction after retry: ${retryResult.error}`,
  };
}

/**
 * Main extension entry point
 */
export default function handoffExtension(pi: ExtensionAPI) {
  // Track last used skill
  let lastSkill: string | undefined;

  // Restore last skill from session on startup
  pi.on("session_start", async (_event, ctx) => {
    lastSkill = undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === SKILL_ENTRY_TYPE
      ) {
        const data = (entry as any).data as SkillEntry | undefined;
        if (data?.skillName) {
          lastSkill = data.skillName;
        }
      }
    }
  });

  // Track skill usage via input event
  pi.on("input", async (event, _ctx) => {
    const skillName = getInvokedSkillName(event.text, pi);

    if (skillName) {
      lastSkill = skillName;

      // Persist to session
      pi.appendEntry(SKILL_ENTRY_TYPE, {
        skillName,
        timestamp: Date.now(),
      } as SkillEntry);
    }

    // Let the input continue processing
    return { action: "continue" };
  });

  // Register the /handoff command
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      try {
        await runHandoffCommand(args, ctx, pi, lastSkill);
      } catch (err) {
        notify(ctx, formatError(err), "error");
      }
    },
  });
}
