import type {
  ExtensionAPI,
  ExtensionCommandContext,
  BeforeAgentStartEvent,
  ContextEvent,
  BeforeProviderRequestEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  ImageContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import path from "node:path";
import fs from "node:fs";

interface DumpSnapshot {
  capturedAt: number;
  prompt?: string;
  images?: ImageContent[];
  /** Base system prompt captured at before_agent_start (before extension mutations). */
  baseSystemPrompt?: string;
  /** Final system prompt extracted from the provider payload (after all extensions). */
  finalSystemPrompt?: string;
  /** The system prompt displayed in the dump. */
  systemPrompt?: string;
  systemPromptOptions?: any;
  messages?: any[];
  providerPayload?: unknown;
}

let snapshot: DumpSnapshot = { capturedAt: 0 };

function extractSystemPromptFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, any>;
  // Anthropic-style: top-level `system` field.
  if (p.system !== undefined) {
    if (typeof p.system === "string") return p.system;
    if (Array.isArray(p.system)) {
      return p.system.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
    }
  }
  // OpenAI-style: first message with role "system".
  if (Array.isArray(p.messages)) {
    const sys = p.messages.find((m: any) => m?.role === "system");
    if (sys) {
      if (typeof sys.content === "string") return sys.content;
      if (Array.isArray(sys.content)) {
        return sys.content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
      }
    }
  }
  return undefined;
}

export function startDumpCapture(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    snapshot.prompt = event.prompt;
    snapshot.images = event.images;
    snapshot.baseSystemPrompt = event.systemPrompt;
    snapshot.systemPrompt = event.systemPrompt;
    snapshot.systemPromptOptions = event.systemPromptOptions;
    snapshot.capturedAt = Date.now();
  });

  pi.on("context", (event: ContextEvent) => {
    snapshot.messages = event.messages as any[];
  });

  pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
    snapshot.providerPayload = event.payload;
    const finalSystem = extractSystemPromptFromPayload(event.payload);
    if (finalSystem !== undefined) {
      snapshot.finalSystemPrompt = finalSystem;
      snapshot.systemPrompt = finalSystem;
    }
  });
}

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n")[0].trim();
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((block: any) => {
      if (!block || typeof block !== "object") return JSON.stringify(block);
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[image ${block.mimeType ?? "?"}, ${(block.data?.length ?? 0).toLocaleString()} chars]`;
      if (block.type === "thinking") return block.redacted ? "[redacted thinking]" : (block.thinking ?? "[thinking]");
      if (block.type === "toolCall") return `[toolCall ${block.name ?? "?"}]`;
      return JSON.stringify(block);
    })
    .join("\n");
}


function countMessagesByRole(messages: any[], role: string): number {
  return messages.filter((m) => (m as any)?.role === role).length;
}

function formatMessageBrief(message: any, index: number): string {
  const msg = message as any;
  if (!msg || typeof msg !== "object") return `${index}. (unreadable)`;
  const role = msg.role ?? "unknown";
  const prefix = `${index}. [${role}]`;
  if (role === "user") {
    return `${prefix} ${firstLine(stringifyContent(msg.content), 140)}`;
  }
  if (role === "assistant") {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ").trim();
    const tools = content.filter((c: any) => c?.type === "toolCall").length;
    const parts: string[] = [];
    if (text) parts.push(firstLine(text, 100));
    if (tools) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
    return `${prefix} ${parts.join(" · ") || "(no text)"}`;
  }
  if (role === "toolResult") {
    const tr = msg as ToolResultMessage;
    const status = tr.isError ? "error" : "ok";
    return `${prefix} ${tr.toolName ?? "?"} (${status})`;
  }
  return `${prefix} ${firstLine(JSON.stringify(msg), 140)}`;
}

function formatMessageFull(message: any, index: number): string[] {
  const lines: string[] = [];
  const msg = message as any;
  if (!msg || typeof msg !== "object") {
    lines.push(`${index}. (unreadable)`);
    lines.push("```json");
    lines.push(JSON.stringify(message, null, 2));
    lines.push("```");
    return lines;
  }
  const role = msg.role ?? "unknown";
  lines.push(`#### ${index}. role: \`${role}\``);
  if (msg.timestamp) {
    lines.push(`**timestamp:** ${new Date(msg.timestamp).toISOString()}`);
  }

  if (role === "user") {
    lines.push("**content:**");
    lines.push("```");
    lines.push(stringifyContent(msg.content));
    lines.push("```");
  } else if (role === "assistant") {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
    const thinking = content.filter((c: any) => c?.type === "thinking");
    const toolCalls = content.filter((c: any) => c?.type === "toolCall");
    if (text) {
      lines.push("**text:**");
      lines.push("```");
      lines.push(text);
      lines.push("```");
    }
    if (thinking.length) {
      lines.push("**thinking:**");
      for (const t of thinking) {
        lines.push("```");
        lines.push(t.redacted ? "[redacted]" : (t.thinking ?? ""));
        lines.push("```");
      }
    }
    if (toolCalls.length) {
      lines.push(`**tool calls:** ${toolCalls.length}`);
      for (const tc of toolCalls) {
        lines.push(`- \`${tc.name ?? "?"}\` · id \`${tc.id ?? "?"}\``);
        lines.push("  ```json");
        lines.push(JSON.stringify(tc.arguments ?? {}, null, 2));
        lines.push("  ```");
      }
    }
    if (msg.model) lines.push(`**model:** ${msg.model}`);
    if (msg.stopReason) lines.push(`**stop reason:** ${msg.stopReason}`);
    if (msg.usage) lines.push(`**usage:** ${JSON.stringify(msg.usage)}`);
  } else if (role === "toolResult") {
    const tr = msg as ToolResultMessage;
    lines.push(`**tool:** ${tr.toolName ?? "?"} · callId \`${tr.toolCallId ?? "?"}\` · error: ${!!tr.isError}`);
    lines.push("**content:**");
    lines.push("```");
    lines.push(stringifyContent(tr.content));
    lines.push("```");
  } else {
    lines.push("```json");
    lines.push(JSON.stringify(msg, null, 2));
    lines.push("```");
  }
  return lines;
}

function getToolSource(tool: ToolInfo): string {
  const source = (tool as any).sourceInfo?.source ?? "unknown";
  if (source === "builtin") return "built-in";
  if (source === "sdk") return "sdk";
  if (source === "local" && (tool as any).sourceInfo?.path) {
    const dir = path.dirname((tool as any).sourceInfo.path);
    return path.basename(dir) || "local";
  }
  return source;
}

function getToolPath(tool: ToolInfo): string {
  const p = (tool as any).sourceInfo?.path ?? "";
  if (p.startsWith("<") && p.endsWith(">")) return "";
  return p;
}

function extractParamSummary(tool: ToolInfo): string[] {
  const schema = tool.parameters as any;
  if (!schema || schema.type !== "object" || typeof schema.properties !== "object") {
    return [];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const p = prop as any;
    const type = Array.isArray(p?.type) ? p.type.join("|") : (p?.type ?? "any");
    const req = required.has(name) ? "required" : "optional";
    const desc = typeof p?.description === "string" ? ` — ${p.description.split("\n")[0]}` : "";
    lines.push(`${name}: ${type} (${req})${desc}`);
  }
  return lines;
}

function formatToolsFull(pi: ExtensionAPI): string {
  const allTools = pi.getAllTools();
  const activeNames = new Set(pi.getActiveTools());
  const sorted = [...allTools].sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push(`# Tools — full catalog (${sorted.length})`);
  lines.push(`Active: ${sorted.filter((t) => activeNames.has(t.name)).length} · Inactive: ${sorted.filter((t) => !activeNames.has(t.name)).length}`);
  lines.push("");

  for (const tool of sorted) {
    const status = activeNames.has(tool.name) ? "🟢 active" : "⚪ inactive";
    lines.push(`## ${tool.name} · ${status} · [${getToolSource(tool)}]`);
    const toolPath = getToolPath(tool);
    if (toolPath) lines.push(`Path: \`${toolPath}\``);
    lines.push("");
    lines.push(tool.description);
    lines.push("");

    if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
      lines.push("### Prompt guidelines");
      for (const g of tool.promptGuidelines) lines.push(`- ${g}`);
      lines.push("");
    }

    lines.push("### Parameters");
    lines.push("```json");
    lines.push(JSON.stringify(tool.parameters, null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function formatToolsBrief(pi: ExtensionAPI): string {
  const allTools = pi.getAllTools();
  const activeNames = new Set(pi.getActiveTools());
  const active = allTools.filter((t) => activeNames.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push(`# Active tools (${active.length} of ${allTools.length})`);
  lines.push("");

  const bySource = new Map<string, ToolInfo[]>();
  for (const tool of active) {
    const source = getToolSource(tool);
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source)!.push(tool);
  }

  for (const source of Array.from(bySource.keys()).sort()) {
    lines.push(`## [${source}]`);
    for (const tool of bySource.get(source)!) {
      lines.push(`- **${tool.name}** — ${firstLine(tool.description)}`);
      const params = extractParamSummary(tool);
      if (params.length > 0) {
        for (const p of params.slice(0, 4)) lines.push(`  - ${p}`);
        if (params.length > 4) lines.push(`  - ... and ${params.length - 4} more params`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatPromptsBrief(ctx: ExtensionCommandContext, systemPromptOverride?: string): string {
  const lines: string[] = [];
  lines.push("# Prompts — brief");
  lines.push("");

  const systemPrompt = systemPromptOverride ?? ctx.getSystemPrompt();
  const opts = ctx.getSystemPromptOptions();
  const messages = snapshot.messages ?? [];

  lines.push(`- **System prompt:** ${systemPrompt.length.toLocaleString()} chars · ${systemPrompt.split("\n").length.toLocaleString()} lines · ~${estimateTokens(systemPrompt).toLocaleString()} tok`);
  if (opts.customPrompt) lines.push(`- **Custom system prompt:** yes (${opts.customPrompt.length.toLocaleString()} chars)`);
  if (opts.appendSystemPrompt) lines.push(`- **Append system prompt:** yes (${opts.appendSystemPrompt.length.toLocaleString()} chars)`);
  lines.push(`- **Prompt guidelines:** ${opts.promptGuidelines?.length ?? 0}`);
  lines.push(`- **Skills discovered:** ${opts.skills?.length ?? 0} (only injected when auto-skills is ON)`);
  lines.push(`- **Context files:** ${opts.contextFiles?.length ?? 0}`);
  lines.push(`- **Selected tools:** ${opts.selectedTools?.length ?? 0}`);
  lines.push(`- **Conversation messages:** ${messages.length} (user ${countMessagesByRole(messages, "user")}, assistant ${countMessagesByRole(messages, "assistant")}, toolResult ${countMessagesByRole(messages, "toolResult")})`);
  if (snapshot.prompt) lines.push(`- **Last user prompt:** ${firstLine(snapshot.prompt)}`);
  if (snapshot.images && snapshot.images.length > 0) lines.push(`- **Attached images:** ${snapshot.images.length}`);

  return lines.join("\n");
}

function formatPromptsFull(ctx: ExtensionCommandContext, systemPromptOverride?: string): string {
  const lines: string[] = [];
  lines.push("# Prompts — full");
  lines.push("");

  const opts = ctx.getSystemPromptOptions();

  lines.push("## System prompt options");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        cwd: opts.cwd,
        customPrompt: opts.customPrompt,
        promptGuidelines: opts.promptGuidelines,
        appendSystemPrompt: opts.appendSystemPrompt,
        selectedTools: opts.selectedTools,
        toolSnippets: opts.toolSnippets,
        skills: opts.skills?.map((s: any) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          disableModelInvocation: s.disableModelInvocation,
        })),
        contextFiles: opts.contextFiles?.map((cf: any) => ({
          path: cf.path,
          length: cf.content.length,
        })),
      },
      null,
      2,
    ),
  );
  lines.push("```");
  lines.push("");

  lines.push("## System prompt");
  lines.push("```");
  lines.push(systemPromptOverride ?? ctx.getSystemPrompt());
  lines.push("```");
  lines.push("");

  const messages = snapshot.messages ?? [];
  if (messages.length > 0) {
    lines.push(`## Conversation (${messages.length} messages)`);
    lines.push("");
    for (let i = 0; i < messages.length; i++) {
      lines.push(...formatMessageFull(messages[i], i + 1));
      lines.push("");
    }
  } else {
    lines.push("## Conversation");
    lines.push("No messages captured yet.");
    lines.push("");
  }

  return lines.join("\n");
}

function formatOther(ctx: ExtensionCommandContext, pi: ExtensionAPI): string {
  const lines: string[] = [];
  lines.push("# Other");
  lines.push("");

  const model = ctx.model;
  if (model) {
    lines.push(`- **Model:** ${model.name} (\`${model.id}\`)`);
    lines.push(`- **Provider:** ${model.provider}`);
    lines.push(`- **API:** ${model.api}`);
    lines.push(`- **Context window:** ${model.contextWindow.toLocaleString()} tokens`);
    lines.push(`- **Max tokens:** ${model.maxTokens.toLocaleString()} tokens`);
    lines.push(`- **Inputs:** ${model.input.join(", ")}`);
  } else {
    lines.push("- **Model:** not set");
  }

  lines.push(`- **Thinking level:** ${pi.getThinkingLevel()}`);
  lines.push(`- **Working directory:** \`${ctx.cwd}\``);

  const usage = ctx.getContextUsage();
  if (usage) {
    const tokens = usage.tokens?.toLocaleString() ?? "?";
    const percent = usage.percent?.toFixed(1) ?? "?";
    lines.push(`- **Context usage:** ${tokens} / ${usage.contextWindow.toLocaleString()} tokens (${percent}%)`);
  } else {
    lines.push("- **Context usage:** unavailable");
  }

  const commands = pi.getCommands();
  lines.push(`- **Registered / commands:** ${commands.length}`);
  for (const cmd of commands.slice(0, 40)) {
    lines.push(`  - \`/${cmd.name}\` — ${cmd.description ?? "no description"} [${cmd.source}]`);
  }
  if (commands.length > 40) lines.push(`  - ... and ${commands.length - 40} more`);

  if (snapshot.providerPayload && typeof snapshot.providerPayload === "object") {
    const payload = snapshot.providerPayload as Record<string, any>;
    lines.push(`- **Last provider payload keys:** ${Object.keys(payload).join(", ") || "(empty)"}`);
    if (payload.model) lines.push(`  - model: ${payload.model}`);
    if (Array.isArray(payload.messages)) lines.push(`  - messages: ${payload.messages.length}`);
    if (Array.isArray(payload.tools)) lines.push(`  - tools: ${payload.tools.length}`);
  }

  return lines.join("\n");
}

function formatFull(ctx: ExtensionCommandContext, pi: ExtensionAPI, systemPromptOverride?: string): string {
  return [
    formatToolsFull(pi),
    "---",
    "",
    formatPromptsFull(ctx, systemPromptOverride),
    "---",
    "",
    formatOther(ctx, pi),
  ].join("\n");
}

function formatHeadlessFallback(ctx: ExtensionCommandContext, pi: ExtensionAPI, systemPromptOverride?: string): string {
  return [
    formatToolsBrief(pi),
    "",
    formatPromptsBrief(ctx, systemPromptOverride),
    "",
    formatOther(ctx, pi),
  ].join("\n");
}

export interface DumpMenuResult {
  choice: "file" | "editor" | "brief" | null;
  scope: "full" | "brief" | null;
}

export async function pickDumpAction(ctx: ExtensionCommandContext): Promise<DumpMenuResult> {
  if (!ctx.hasUI) {
    return { choice: "file", scope: "brief" };
  }

  const action = await ctx.ui.select("Dump context to", [
    "📄 File (full)",
    "📄 File (brief)",
    "🖥  Editor (full)",
    "🖥  Editor (brief)",
    "Cancel",
  ]);

  if (action?.startsWith("📄 File")) {
    return { choice: "file", scope: action.includes("brief") ? "brief" : "full" };
  }
  if (action?.startsWith("🖥  Editor")) {
    return { choice: "editor", scope: action.includes("brief") ? "brief" : "full" };
  }
  return { choice: null, scope: null };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50);
}

function writeDumpToFile(content: string, cwd: string, prefix = "pi-context-dump"): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${prefix}-${sanitizeFilename(path.basename(cwd))}-${ts}.md`;
  const filePath = path.join(cwd, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function getEffectiveSystemPrompt(ctx: ExtensionCommandContext): { prompt: string; isPreTurn: boolean } {
  const isPreTurn = !snapshot.finalSystemPrompt;
  const prompt =
    snapshot.finalSystemPrompt ??
    snapshot.baseSystemPrompt ??
    ctx.getSystemPrompt();
  return { prompt, isPreTurn };
}

function formatProviderPromptOnly(ctx: ExtensionCommandContext, pi: ExtensionAPI): string {
  const { prompt } = getEffectiveSystemPrompt(ctx);
  const messages = snapshot.messages ?? [];
  const lines: string[] = [];

  lines.push("# Provider prompt");
  lines.push("");
  lines.push("## System prompt");
  lines.push("```");
  lines.push(prompt);
  lines.push("```");
  lines.push("");

  if (messages.length > 0) {
    lines.push(`## Conversation messages (${messages.length})`);
    lines.push("");
    for (let i = 0; i < messages.length; i++) {
      lines.push(...formatMessageFull(messages[i], i + 1));
      lines.push("");
    }
  } else {
    lines.push("## Conversation messages");
    lines.push("No messages captured yet.");
    lines.push("");
  }

  const active = pi.getActiveTools();
  lines.push(`## Active tools (${active.length})`);
  for (const name of active) {
    lines.push(`- ${name}`);
  }

  return lines.join("\n");
}

export async function runProviderPromptDump(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  snapshot.systemPromptOptions = ctx.getSystemPromptOptions();

  const { prompt, isPreTurn } = getEffectiveSystemPrompt(ctx);
  const { choice } = await pickDumpAction(ctx);
  if (!choice) return;

  let md = formatProviderPromptOnly(ctx, pi);

  if (isPreTurn) {
    md +=
      "\n\n> **Note:** This dump was generated before the first LLM turn, so the system prompt shown is the base prompt **before** extensions such as `role-sw` and `context-guard` have mutated it. Run the dump again after at least one agent response to see the final prompt sent to the provider.\n";
  }

  if (choice === "file") {
    const filePath = writeDumpToFile(md, ctx.cwd, "pi-provider-prompt");
    const msg = `Provider prompt dump saved: ${filePath}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "info");
    else console.log(msg);
    return;
  }

  if (choice === "editor") {
    await ctx.ui.editor("provider-prompt", md);
    return;
  }

  console.log(md);
}

export async function runContextDump(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  // Refresh options, but prefer the final system prompt captured from the
  // actual provider request (after all before_agent_start extensions).
  snapshot.systemPromptOptions = ctx.getSystemPromptOptions();

  const { prompt: effectiveSystemPrompt, isPreTurn } = getEffectiveSystemPrompt(ctx);

  const { choice, scope } = await pickDumpAction(ctx);
  if (!choice) return;

  const isFull = scope === "full";
  let md = isFull ? formatFull(ctx, pi, effectiveSystemPrompt) : formatHeadlessFallback(ctx, pi, effectiveSystemPrompt);

  if (isPreTurn) {
    md +=
      "\n\n> **Note:** This dump was generated before the first LLM turn, so the system prompt shown is the base prompt **before** extensions such as `role-sw` and `context-guard` have mutated it. Run the dump again after at least one agent response to see the final prompt sent to the provider.\n";
  }

  if (choice === "file") {
    const filePath = writeDumpToFile(md, ctx.cwd, "pi-context-dump");
    const msg = `Context dump saved: ${filePath}`;
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  if (choice === "editor") {
    await ctx.ui.editor(isFull ? "context-dump-full" : "context-dump-brief", md);
    return;
  }

  // No UI fallback — print to stdout.
  console.log(md);
}
