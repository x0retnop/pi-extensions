import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Type } from "typebox";

const TOOL_NAME = "list_my_tools";

interface ParamSummary {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

function getToolGroup(tool: ToolInfo): string {
  const source = tool.sourceInfo?.source ?? "unknown";
  if (source === "builtin") return "Built-in tools";
  if (source === "sdk") return "SDK tools";
  if (source === "local" && tool.sourceInfo?.path) {
    const dir = path.dirname(tool.sourceInfo.path);
    return path.basename(dir) || "Local extension";
  }
  return source;
}

function extractParams(tool: ToolInfo): ParamSummary[] {
  const schema = tool.parameters as any;
  if (!schema || schema.type !== "object" || typeof schema.properties !== "object") {
    return [];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const params: ParamSummary[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const p = prop as any;
    params.push({
      name,
      type: Array.isArray(p?.type) ? p.type.join("|") : (p?.type ?? "any"),
      required: required.has(name),
      description: typeof p?.description === "string" ? p.description : undefined,
    });
  }
  return params;
}

function firstLine(text: string, max = 160): string {
  const line = text.split("\n")[0].trim();
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}

function formatParam(p: ParamSummary): string {
  const req = p.required ? "required" : "optional";
  let out = `\`${p.name}\` (${p.type}, ${req})`;
  if (p.description) {
    const desc = firstLine(p.description, 80);
    out += ` — ${desc}`;
  }
  return out;
}

function formatTool(tool: ToolInfo, active: boolean): string {
  const status = active ? "active" : "inactive";
  let out = `- **${tool.name}** (${status}) — ${firstLine(tool.description)}`;
  const params = extractParams(tool);
  if (params.length > 0) {
    const lines = params.slice(0, 8).map((p) => `  - ${formatParam(p)}`);
    if (params.length > 8) {
      lines.push(`  - …and ${params.length - 8} more parameters`);
    }
    out += "\n" + lines.join("\n");
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "List My Tools",
    description:
      "Returns the full, up-to-date catalog of every available tool with descriptions and parameter summaries. " +
      "ALWAYS call this tool when the user asks about your capabilities, available tools, or what you can do.",
    promptSnippet: "list_my_tools — returns the catalog of all available tools",
    promptGuidelines: [
      "When the user asks about your capabilities, available tools, or what you can do, call list_my_tools first.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const allTools = pi.getAllTools();
      const activeNames = new Set(pi.getActiveTools());

      // Exclude this meta-tool from its own listing.
      const tools = allTools.filter((t) => t.name !== TOOL_NAME);
      const activeTools = tools.filter((t) => activeNames.has(t.name));
      const inactiveTools = tools.filter((t) => !activeNames.has(t.name));

      const byGroup = new Map<string, ToolInfo[]>();
      for (const tool of activeTools) {
        const group = getToolGroup(tool);
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group)!.push(tool);
      }

      const lines: string[] = [];
      lines.push(`# Available tools (${activeTools.length} active of ${tools.length} total)`);
      lines.push("");

      const groupNames = Array.from(byGroup.keys()).sort((a, b) => {
        if (a === "Built-in tools") return -1;
        if (b === "Built-in tools") return 1;
        if (a === "SDK tools") return -1;
        if (b === "SDK tools") return 1;
        return a.localeCompare(b);
      });

      for (const group of groupNames) {
        lines.push(`## ${group}`);
        const sorted = byGroup.get(group)!.sort((a, b) => a.name.localeCompare(b.name));
        for (const tool of sorted) {
          lines.push(formatTool(tool, true));
        }
        lines.push("");
      }

      if (inactiveTools.length > 0) {
        lines.push("## Inactive (available but not currently enabled)");
        const sorted = inactiveTools.sort((a, b) => a.name.localeCompare(b.name));
        for (const tool of sorted) {
          lines.push(formatTool(tool, false));
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          total: tools.length,
          active: activeTools.length,
          inactive: inactiveTools.length,
        },
      };
    },
  });
}
