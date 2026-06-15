import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolInfo,
  BuildSystemPromptOptions,
  ContextEvent,
  BeforeProviderRequestEvent,
  BeforeAgentStartEvent,
  SlashCommandInfo,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

const EXT = "tool-dev";

interface Snapshot {
  capturedAt: number;
  systemPrompt?: string;
  systemPromptOptions?: BuildSystemPromptOptions;
  prompt?: string;
  images?: ImageContent[];
  messages?: any[];
  providerPayload?: unknown;
}

let snapshot: Snapshot = { capturedAt: 0 };

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  const text = message.startsWith(`[${EXT}]`) ? message : `[${EXT}] ${message}`;
  if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
    ctx.ui.notify(text, level);
    return;
  }
  const log = level === "error" ? console.error : level === "warning" ? console.warn : console.log;
  log(text);
}

function getToolSource(tool: ToolInfo): string {
  const source = tool.sourceInfo?.source ?? "unknown";
  if (source === "builtin") return "built-in";
  if (source === "sdk") return "sdk";
  if (source === "local" && tool.sourceInfo?.path) {
    const dir = path.dirname(tool.sourceInfo.path);
    return path.basename(dir) || "local";
  }
  return source;
}

function getToolPath(tool: ToolInfo): string {
  if (!tool.sourceInfo?.path) return "";
  const p = tool.sourceInfo.path;
  if (p.startsWith("<") && p.endsWith(">")) return "";
  return p;
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n")[0].trim();
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}

function formatSchema(tool: ToolInfo): string {
  const schema = tool.parameters as any;
  if (!schema || typeof schema !== "object") return "(no schema)";
  return JSON.stringify(schema, null, 2);
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

function stringifyContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((block: any) => {
      if (!block || typeof block !== "object") return JSON.stringify(block);
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[image ${block.mimeType ?? "?"}, ${(block.data?.length ?? 0).toLocaleString()} chars]`;
      if (block.type === "thinking") return block.redacted ? "[redacted thinking]" : (block.thinking ?? "[thinking]");
      return JSON.stringify(block);
    })
    .join("\n");
}

function getMessages(ctx: ExtensionCommandContext): any[] {
  if (snapshot.messages && snapshot.messages.length > 0) return snapshot.messages;
  try {
    const leafId = ctx.sessionManager.getLeafId();
    const entries = ctx.sessionManager.getEntries();
    return buildSessionContext(entries, leafId).messages;
  } catch {
    return [];
  }
}

function countMessagesByRole(messages: any[], role: string): number {
  return messages.filter((m) => m?.role === role).length;
}

function formatMessageBrief(message: any, index: number): string {
  if (!message || typeof message !== "object") return `${index}. (unreadable)`;
  const role = message.role ?? "unknown";
  const prefix = `${index}. [${role}]`;
  if (role === "user") {
    return `${prefix} ${firstLine(stringifyContent(message.content), 140)}`;
  }
  if (role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ").trim();
    const tools = content.filter((c: any) => c?.type === "toolCall").length;
    const parts: string[] = [];
    if (text) parts.push(firstLine(text, 100));
    if (tools) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
    return `${prefix} ${parts.join(" · ") || "(no text)"}`;
  }
  if (role === "toolResult") {
    const status = message.isError ? "error" : "ok";
    return `${prefix} ${message.toolName ?? "?"} (${status})`;
  }
  return `${prefix} ${firstLine(JSON.stringify(message), 140)}`;
}

function formatMessageFull(message: any, index: number): string[] {
  const lines: string[] = [];
  if (!message || typeof message !== "object") {
    lines.push(`${index}. (unreadable)`);
    lines.push("```json");
    lines.push(JSON.stringify(message, null, 2));
    lines.push("```");
    return lines;
  }
  const role = message.role ?? "unknown";
  lines.push(`#### ${index}. role: \`${role}\``);
  if (message.timestamp) {
    lines.push(`**timestamp:** ${new Date(message.timestamp).toISOString()}`);
  }

  if (role === "user") {
    lines.push("**content:**");
    lines.push("```");
    lines.push(stringifyContent(message.content));
    lines.push("```");
  } else if (role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
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
    if (message.model) lines.push(`**model:** ${message.model}`);
    if (message.stopReason) lines.push(`**stop reason:** ${message.stopReason}`);
    if (message.usage) lines.push(`**usage:** ${JSON.stringify(message.usage)}`);
  } else if (role === "toolResult") {
    lines.push(`**tool:** ${message.toolName ?? "?"} · callId \`${message.toolCallId ?? "?"}\` · error: ${!!message.isError}`);
    lines.push("**content:**");
    lines.push("```");
    lines.push(stringifyContent(message.content));
    lines.push("```");
  } else {
    lines.push("```json");
    lines.push(JSON.stringify(message, null, 2));
    lines.push("```");
  }
  return lines;
}

function dumpToFile(content: string): string {
  const tmpDir = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "pi-tool-dev");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `inspect-${Date.now()}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function formatToolsBrief(pi: ExtensionAPI): string {
  const allTools = pi.getAllTools();
  const activeNames = new Set(pi.getActiveTools());
  const active = allTools.filter((t) => activeNames.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push(`# Tools — active (${active.length} of ${allTools.length})`);
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
    lines.push(formatSchema(tool));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function formatPromptsBrief(ctx: ExtensionCommandContext): string {
  const lines: string[] = [];
  lines.push("# Prompts — brief");
  lines.push("");

  const systemPrompt = ctx.getSystemPrompt();
  const opts = ctx.getSystemPromptOptions();
  const messages = getMessages(ctx);

  lines.push(`- **System prompt:** ${systemPrompt.length.toLocaleString()} chars · ${systemPrompt.split("\n").length.toLocaleString()} lines`);
  if (opts.customPrompt) lines.push(`- **Custom system prompt:** yes (${opts.customPrompt.length.toLocaleString()} chars)`);
  if (opts.appendSystemPrompt) lines.push(`- **Append system prompt:** yes (${opts.appendSystemPrompt.length.toLocaleString()} chars)`);
  lines.push(`- **Prompt guidelines:** ${opts.promptGuidelines?.length ?? 0}`);
  lines.push(`- **Skills loaded:** ${opts.skills?.length ?? 0}`);
  lines.push(`- **Context files:** ${opts.contextFiles?.length ?? 0}`);
  lines.push(`- **Selected tools:** ${opts.selectedTools?.length ?? 0}`);
  lines.push(`- **Conversation messages:** ${messages.length} (user ${countMessagesByRole(messages, "user")}, assistant ${countMessagesByRole(messages, "assistant")}, toolResult ${countMessagesByRole(messages, "toolResult")})`);
  if (snapshot.prompt) lines.push(`- **Last user prompt:** ${firstLine(snapshot.prompt)}`);
  if (snapshot.images && snapshot.images.length > 0) lines.push(`- **Attached images:** ${snapshot.images.length}`);

  return lines.join("\n");
}

function formatPromptsFull(ctx: ExtensionCommandContext): string {
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
        skills: opts.skills?.map((s) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          disableModelInvocation: s.disableModelInvocation,
        })),
        contextFiles: opts.contextFiles?.map((cf) => ({
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
  lines.push(ctx.getSystemPrompt());
  lines.push("```");
  lines.push("");

  const messages = getMessages(ctx);
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
    lines.push(`- **Max tokens:** ${model.maxTokens.toLocaleString()}`);
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

function formatFull(ctx: ExtensionCommandContext, pi: ExtensionAPI): string {
  return [
    formatToolsFull(pi),
    "---",
    "",
    formatPromptsFull(ctx),
    "---",
    "",
    formatOther(ctx, pi),
  ].join("\n");
}

function formatHeadlessFallback(ctx: ExtensionCommandContext, pi: ExtensionAPI): string {
  return [
    formatToolsBrief(pi),
    "",
    formatPromptsBrief(ctx),
    "",
    formatOther(ctx, pi),
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    snapshot.prompt = event.prompt;
    snapshot.images = event.images;
    snapshot.systemPrompt = event.systemPrompt;
    snapshot.systemPromptOptions = event.systemPromptOptions;
    snapshot.capturedAt = Date.now();
  });

  pi.on("context", (event: ContextEvent) => {
    snapshot.messages = event.messages;
  });

  pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
    snapshot.providerPayload = event.payload;
  });

  pi.registerCommand("inspect", {
    description: "Interactive inspector for everything the LLM sees (tools, prompts, other, full)",
    handler: async (_args, ctx) => {
      // Always refresh live system prompt data when the command runs.
      snapshot.systemPrompt = ctx.getSystemPrompt();
      snapshot.systemPromptOptions = ctx.getSystemPromptOptions();

      if (!ctx.hasUI) {
        const md = formatHeadlessFallback(ctx, pi);
        const filePath = dumpToFile(md);
        notify(ctx, `Headless report saved to ${filePath}`, "info");
        return;
      }

      const choice = await ctx.ui.select("🔍 Inspect LLM context", [
        "Tools — brief",
        "Tools — full",
        "Prompts — brief",
        "Prompts — full",
        "Other",
        "Full report",
      ]);
      if (!choice) return;

      let md = "";
      switch (choice) {
        case "Tools — brief":
          md = formatToolsBrief(pi);
          break;
        case "Tools — full":
          md = formatToolsFull(pi);
          break;
        case "Prompts — brief":
          md = formatPromptsBrief(ctx);
          break;
        case "Prompts — full":
          md = formatPromptsFull(ctx);
          break;
        case "Other":
          md = formatOther(ctx, pi);
          break;
        case "Full report":
        default:
          md = formatFull(ctx, pi);
          break;
      }

      await ctx.ui.editor(choice, md);
      notify(ctx, `${choice} opened in editor`, "info");
    },
  });
}
