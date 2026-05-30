import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

const EXT = "pi-request-inspector";

let lastPayload: unknown = null;
let autoSave = false;

function formatDate(d = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function truncate(str: string, max = 25000): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n\n... [truncated ${str.length - max} chars]`;
}

function inspectDir(cwd: string): string {
  return path.join(cwd, ".pi-inspect");
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function extractPayload(event: unknown): any {
  if (event && typeof event === "object") {
    const e = event as any;
    if (Array.isArray(e.messages) || Array.isArray(e.tools) || e.model) return e;
    if (e.payload) return e.payload;
  }
  return event;
}

function messageContentText(m: any): string {
  if (m.content === null || m.content === undefined) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c: any) => {
        if (c.type === "text") return c.text;
        if (c.type === "image_url") return `[image: ${(c.image_url?.url || "").slice(0, 80)}...]`;
        if (c.type === "image") return `[image: ${(c.source?.data || c.data || "").slice(0, 80)}...]`;
        if (c.type === "tool_use" || c.type === "function") return `[tool_use: ${c.name || c.function?.name} id=${c.id}]`;
        if (c.type === "tool_result" || c.type === "tool_response") return `[tool_result: id=${c.tool_use_id || c.tool_call_id}]`;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(m.content, null, 2);
}

function buildMarkdown(payload: any, ctx: ExtensionContext): string {
  const model = (ctx as any).model?.id || "unknown";
  let md = `# Pi Request Inspection\n\n`;
  md += `- **Timestamp:** ${new Date().toISOString()}\n`;
  md += `- **Model:** ${model}\n`;

  const usage = ctx.getContextUsage?.();
  if (usage) {
    md += `- **Context:** ${usage.tokens}/${usage.contextWindow} (${usage.percent.toFixed(1)}%)\n`;
  }

  const extraKeys = Object.keys(payload || {}).filter(
    (k) => !["messages", "tools", "model", "temperature", "top_p", "max_tokens", "stream"].includes(k)
  );
  if (extraKeys.length) {
    md += `- **Extra params:** ${extraKeys.join(", ")}\n`;
  }
  md += `\n---\n\n`;

  const messages = payload?.messages || [];
  const systemMsg = messages.find((m: any) => m.role === "system" || m.role === "developer");
  if (systemMsg) {
    md += `## System Prompt\n\n\`\`\`\n${truncate(messageContentText(systemMsg))}\n\`\`\`\n\n`;
  }

  md += `## Messages (${messages.length})\n\n`;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role || "unknown";
    const text = messageContentText(m);
    md += `### #${i + 1} — role: ${role}\n\n\`\`\`\n${truncate(text, 12000)}\n\`\`\`\n\n`;
  }

  const tools = payload?.tools || [];
  if (tools.length > 0) {
    md += `## Tools (${tools.length})\n\n`;
    for (const t of tools) {
      const fn = t.function || t;
      const name = fn.name || t.name || "unnamed";
      const desc = fn.description || t.description || "";
      const schema = fn.parameters || t.parameters || {};
      md += `### ${name}\n\n`;
      if (desc) md += `**Description:** ${desc}\n\n`;
      md += `\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n\n`;
    }
  }

  md += `---\n\n## Full Raw Payload\n\n\`\`\`json\n${truncate(JSON.stringify(payload, null, 2), 40000)}\n\`\`\`\n`;

  return md;
}

function saveInspection(payload: any, ctx: ExtensionContext): string {
  const dir = inspectDir(ctx.cwd);
  ensureDir(dir);
  const file = path.join(dir, `inspect-${formatDate()}.md`);
  fs.writeFileSync(file, buildMarkdown(payload, ctx), "utf-8");
  return file;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  const text = message.startsWith(`[${EXT}]`) ? message : `[${EXT}] ${message}`;
  if (ctx.hasUI && typeof (ctx.ui as any)?.notify === "function") {
    (ctx.ui as any).notify(text, level);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = extractPayload(event);
    lastPayload = payload;
    if (autoSave && payload) {
      try {
        const file = saveInspection(payload, ctx);
        notify(ctx, `Auto-saved: ${file}`, "info");
      } catch {
        // silent in auto-save
      }
    }
    return undefined;
  });

  pi.registerCommand("inspect", {
    description: "Dump the last provider request to ./.pi-inspect/inspect-<timestamp>.md",
    handler: async (_args, ctx) => {
      if (!lastPayload) {
        notify(ctx, "No request captured yet. Run a turn first.", "warning");
        return;
      }
      try {
        const file = saveInspection(lastPayload, ctx);
        notify(ctx, `Saved: ${file}`, "info");
      } catch (err) {
        notify(ctx, `Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("inspect-toggle", {
    description: "Toggle auto-save of every provider request to ./.pi-inspect/",
    handler: async (_args, ctx) => {
      autoSave = !autoSave;
      notify(ctx, `Auto-save ${autoSave ? "ON" : "OFF"}`, "info");
    },
  });
}
