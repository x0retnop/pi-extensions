import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

const EXT = "tool-dev";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  const text = message.startsWith(`[${EXT}]`) ? message : `[${EXT}] ${message}`;
  if (ctx.hasUI && typeof (ctx.ui as any)?.notify === "function") {
    (ctx.ui as any).notify(text, level);
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
    lines.push(`    ${name}: ${type} (${req})${desc}`);
  }
  return lines;
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n")[0].trim();
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}

function formatActiveTools(ctx: ExtensionCommandContext, allTools: ToolInfo[], activeNames: Set<string>): string {
  const active = allTools.filter((t) => activeNames.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(`Active tools sent to LLM (${active.length}):`);
  lines.push("");

  const bySource = new Map<string, ToolInfo[]>();
  for (const tool of active) {
    const source = getToolSource(tool);
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source)!.push(tool);
  }

  for (const source of Array.from(bySource.keys()).sort()) {
    lines.push(`[${source}]`);
    for (const tool of bySource.get(source)!) {
      lines.push(`  ${tool.name}`);
      lines.push(`    ${firstLine(tool.description)}`);
      const params = extractParamSummary(tool);
      if (params.length > 0) {
        lines.push(...params.slice(0, 6));
        if (params.length > 6) lines.push(`    ... and ${params.length - 6} more params`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatAllTools(ctx: ExtensionCommandContext, allTools: ToolInfo[], activeNames: Set<string>): string {
  const sorted = [...allTools].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(`All registered tools (${sorted.length}):`);
  lines.push(`Active: ${sorted.filter((t) => activeNames.has(t.name)).length}`);
  lines.push(`Inactive: ${sorted.filter((t) => !activeNames.has(t.name)).length}`);
  lines.push("");

  for (const tool of sorted) {
    const status = activeNames.has(tool.name) ? "ACTIVE" : "inactive";
    const source = getToolSource(tool);
    const sourcePath = getToolPath(tool);
    lines.push(`────────────────────────────────────────`);
    lines.push(`${tool.name} [${status}] [${source}]`);
    if (sourcePath) lines.push(`path: ${sourcePath}`);
    lines.push("");
    lines.push("description:");
    lines.push(tool.description);
    lines.push("");

    if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
      lines.push("promptGuidelines:");
      for (const g of tool.promptGuidelines) lines.push(`  - ${g}`);
    }

    lines.push("parameters:");
    lines.push(formatSchema(tool));
    lines.push("");
  }

  return lines.join("\n");
}

function dumpToFile(ctx: ExtensionCommandContext, content: string): string {
  const tmpDir = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "pi-tool-dev");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `tools-${Date.now()}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tools", {
    description: "Show tools currently visible to the LLM",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const activeNames = new Set(pi.getActiveTools());
      const output = formatActiveTools(ctx, allTools, activeNames);
      const filePath = dumpToFile(ctx, output);
      notify(ctx, `Active tools dumped to ${filePath}`, "info");
      if (ctx.hasUI && typeof (ctx.ui as any)?.notify === "function") {
        ctx.ui.pasteToEditor(filePath);
      }
    },
  });

  pi.registerCommand("tools-all", {
    description: "Show all registered tools with full schemas",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const activeNames = new Set(pi.getActiveTools());
      const output = formatAllTools(ctx, allTools, activeNames);
      const filePath = dumpToFile(ctx, output);
      notify(ctx, `Full tool catalog dumped to ${filePath}`, "info");
      if (ctx.hasUI && typeof (ctx.ui as any)?.notify === "function") {
        ctx.ui.pasteToEditor(filePath);
      }
    },
  });
}
