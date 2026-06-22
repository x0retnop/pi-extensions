import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";

const SETTINGS_PATH = path.join(getAgentDir(), "settings.json");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Allow runtime injection of a different base URL for tests.
let BASE_URL =
  process.env.PI_PROJECT_MEMORY_URL?.trim() ||
  process.env.PI_BACKEND_URL?.trim() ||
  "http://127.0.0.1:8000";

export function setBaseUrl(url: string): void { BASE_URL = url; }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiRecord {
  item_id: string;
  project_id: string;
  category: string;
  type: string;
  topic: string;
  what: string;
  why?: string;
  where?: string[];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  score?: number;
}

interface ExtractedFact {
  fact_type: "decision" | "pattern" | "gotcha" | "architecture" | "bugfix";
  topic: string;
  what: string;
  where?: string[];
}

interface AddResult {
  ok: boolean;
  item_id?: string;
  duplicate?: boolean;
  score?: number;
  method?: string;
  error?: string;
}

interface ToolResultDetails {
  project_id?: string;
  item_id?: string;
  count?: number;
  hits?: number;
  phase?: string;
  duplicate?: boolean;
  score?: number;
  method?: string;
  error?: string;
  fields?: Record<string, unknown>;
  source_item_id?: string;
  target_item_id?: string;
  result?: unknown;
}

interface CurateState {
  enabled: boolean;
  mode: "auto" | "manual";
}

interface ProjectMemorySettings {
  debug?: boolean;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolResultDetails;
};

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

export async function resolveProjectId(cwd: string): Promise<string> {
  try {
    const text = await fsPromises.readFile(path.join(cwd, ".project-id"), "utf-8");
    const id = text.trim().split(/\r?\n/)[0].trim();
    if (id) return id;
  } catch {
    // fall through to fallback
  }
  return path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_") + "_fallback";
}

function hasProjectId(cwd: string): boolean {
  try {
    const target = path.join(cwd, ".project-id");
    const text = fs.readFileSync(target, "utf-8");
    const id = text.trim().split(/\r?\n/)[0].trim();
    return id.length > 0;
  } catch {
    return false;
  }
}

function getLatestCurateState(ctx: ExtensionContext): CurateState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === PROJECT_MEMORY_CURATE_STATE_TYPE) {
      return entry.data as CurateState;
    }
  }
  return null;
}

const PROJECT_FACTS_TOOL = "project_facts";
const CURATE_FACTS_TOOL = "curate_facts";
const PROJECT_MEMORY_CURATE_STATE_TYPE = "project-memory-curate-state";
const SETTINGS_KEY = "projectMemory";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getProjectMemorySettings(): ProjectMemorySettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed[SETTINGS_KEY] as ProjectMemorySettings) ?? {};
  } catch {
    return {};
  }
}

async function saveProjectMemorySettings(settings: ProjectMemorySettings): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    parsed = JSON.parse(raw);
  } catch {
    // start fresh
  }
  parsed[SETTINGS_KEY] = settings;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2), "utf-8");
}

export async function apiPost(endpoint: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Project memory error: ${message}` }],
    details: { error: message },
  };
}

// ---------------------------------------------------------------------------
// Add-result formatting
// ---------------------------------------------------------------------------

function formatAddResult(result: AddResult, topic: string): { message: string; details: ToolResultDetails } {
  if (!result.ok) {
    const msg = result.error || "Failed to save";
    return { message: `Project memory error: ${msg}`, details: { error: msg } };
  }
  if (result.duplicate && result.item_id) {
    const methodPart = result.method ? `, method: ${result.method}` : "";
    const score = result.score !== undefined ? ` (score: ${result.score.toFixed(3)}${methodPart})` : "";
    return {
      message: `Skipped duplicate "${topic}". Existing record: ${result.item_id}${score}`,
      details: { item_id: result.item_id, duplicate: true, score: result.score, method: result.method },
    };
  }
  return {
    message: `Saved "${topic}" (id: ${result.item_id})`,
    details: { item_id: result.item_id },
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECORD_LEN = 1200;

function formatRecordPreview(r: ApiRecord, maxLen = DEFAULT_MAX_RECORD_LEN): string {
  let s = `[${r.category}] ${r.topic}\n${r.what}`;
  if (r.why) s += `\nWhy: ${r.why}`;
  if (r.where?.length) s += `\nWhere: ${r.where.join(", ")}`;
  if (r.tags?.length) s += `\nTags: ${r.tags.join(", ")}`;
  if (s.length > maxLen) s = s.slice(0, maxLen) + "...";
  return s;
}

function formatRecordDetail(r: ApiRecord): string {
  let out = `## ${r.topic}\n`;
  out += `ID: ${r.item_id}\n`;
  out += `Type: ${r.type} | Category: ${r.category}\n`;
  out += `What: ${r.what}\n`;
  if (r.why) out += `Why: ${r.why}\n`;
  if (r.where?.length) out += `Where: ${r.where.join(", ")}\n`;
  if (r.tags?.length) out += `Tags: ${r.tags.join(", ")}\n`;
  out += `Created: ${r.created_at ?? "unknown"}`;
  return out.trimEnd();
}

function formatListPreview(items: ApiRecord[], includeScore = false): string {
  if (items.length === 0) return "No items.";
  return items
    .map((r, i) => {
      const score = includeScore && r.score !== undefined ? ` (score: ${r.score.toFixed(3)})` : "";
      return `--- ${i} ---\nID: ${r.item_id}${score}\n${formatRecordPreview(r)}`;
    })
    .join("\n\n");
}

/** Enforce a hard cap on total tool-result text so the agent context is protected. */
function clampTotalText(items: ApiRecord[], baseText: string, maxTotalChars = 12000): string {
  let text = baseText;
  for (let i = items.length - 1; i >= 0; i--) {
    const preview = formatListPreview([items[i]]);
    if (text.length + preview.length + 2 <= maxTotalChars) {
      // already included in baseText
      continue;
    }
    const marker = `\n\n[Result truncated: ${items.length - i - 1} record(s) omitted to stay within context limits. Use a narrower query or lower limit.]\n\n`;
    const keepLen = Math.max(0, maxTotalChars - marker.length);
    text = text.slice(0, keepLen) + marker;
    break;
  }
  if (text.length > maxTotalChars) {
    text = text.slice(0, maxTotalChars - 3) + "...";
  }
  return text;
}

function formatRecordDate(r: ApiRecord): string {
  if (!r.created_at) return "no date";
  return r.created_at.slice(0, 10);
}

function formatTuiLabel(r: ApiRecord, i: number, tag?: string): string {
  const date = formatRecordDate(r);
  const labelTag = tag || r.category;
  const topic = r.topic.slice(0, 40);
  const whatPreview = r.what ? ` — ${r.what.slice(0, 60)}` : "";
  return `${i}. ${date} [${labelTag}] ${topic}${whatPreview}`;
}

// ---------------------------------------------------------------------------
// Tool rendering helpers
// ---------------------------------------------------------------------------

function renderError(theme: any, error: string) {
  return new Text(theme.fg("error", `Error: ${error}`), 0, 0);
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((c) => c.type === "text")?.text || "";
}

// ---------------------------------------------------------------------------
// Schema pieces
// ---------------------------------------------------------------------------

const QuerySchema = Type.String({
  minLength: 1,
  maxLength: 500,
  description: "What to search for. Be specific — use technical terms, file names, or problem descriptions.",
});

const ItemIdSchema = Type.String({
  minLength: 1,
  description: "Exact item_id from a previous result.",
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
    } else {
      pi.sendMessage({ customType: "pm", content: message, display: true }, { triggerTurn: false });
    }
  }

  function notifyError(ctx: ExtensionContext | ExtensionCommandContext, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    notify(ctx, `Error: ${msg}`, "error");
  }

  async function getProjectIdOrError(ctx: ExtensionContext): Promise<string | ToolResult> {
    if (!hasProjectId(ctx.cwd)) {
      return errorResult(
        `Project memory is not configured for this directory. Create a .project-id file in ${ctx.cwd} to enable project memory tools.`,
      );
    }
    return resolveProjectId(ctx.cwd);
  }

  // Hide project memory tools from the LLM when the session cwd has no
  // .project-id file. Tools stay registered so CLI commands keep working.
  function syncProjectMemoryTools(ctx: ExtensionContext): void {
    const enabled = hasProjectId(ctx.cwd);
    const curateState = getLatestCurateState(ctx);
    const active = new Set(pi.getActiveTools());
    if (enabled) {
      active.add(PROJECT_FACTS_TOOL);
    } else {
      active.delete(PROJECT_FACTS_TOOL);
    }
    if (curateState?.enabled) {
      active.add(CURATE_FACTS_TOOL);
    } else {
      active.delete(CURATE_FACTS_TOOL);
    }
    pi.setActiveTools([...active]);
  }

  function setCurateStatus(ctx: ExtensionContext | ExtensionCommandContext, state: CurateState | null): void {
    if (ctx.hasUI) {
      const text = state?.enabled ? `pm-curate: ${state.mode}` : undefined;
      ctx.ui.setStatus("project-memory-curate", text);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    syncProjectMemoryTools(ctx);
    if (ctx.hasUI) {
      const status = hasProjectId(ctx.cwd) ? "on" : "off";
      ctx.ui.setStatus("project-memory", `pm: ${status}`);
      setCurateStatus(ctx, getLatestCurateState(ctx));
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    syncProjectMemoryTools(ctx);
    if (ctx.hasUI) {
      setCurateStatus(ctx, getLatestCurateState(ctx));
    }
  });

  // -------------------------------------------------------------------------
  // project_facts — single source of project knowledge for agents
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: PROJECT_FACTS_TOOL,
    label: "Project Facts",
    description:
      "Read durable facts about this project. Use for conventions, architecture, patterns, gotchas, and historical decisions.",
    promptSnippet: "Get project facts that will help answer the user's question.",
    promptGuidelines: [
      "Call this tool at the start of a session or when facing a non-obvious decision.",
      "Pass a specific `query` to search semantically, or set `recent: true` to see the latest facts.",
      "The tool returns full records. Each fact is rendered with all fields (topic, what, why, where, tags).",
      "Limit is 1-20. Use 10 by default, 20 only when you need a broad review. Very large results are truncated to protect context.",
    ],
    parameters: Type.Object({
      query: Type.Optional(QuerySchema),
      recent: Type.Optional(Type.Boolean({
        default: false,
        description: "If true (or if query is omitted), return the most recent facts instead of searching.",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 20,
        default: 10,
        description: "Max facts to return (1-20).",
      })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx): Promise<ToolResult> {
      const projectId = await getProjectIdOrError(ctx);
      if (typeof projectId !== "string") return projectId;

      const query = params.query?.trim();
      const recent = params.recent ?? !query;
      const limit = params.limit ?? 10;

      try {
        let records: ApiRecord[];
        if (recent) {
          onUpdate?.({ content: [{ type: "text", text: `Fetching recent project facts for "${projectId}"...` }], details: { phase: "recent" } });
          const data = await apiPost("/api/project_memory/list", {
            project_id: projectId,
            category: "facts",
            limit,
          });
          records = data.records || [];
        } else {
          onUpdate?.({ content: [{ type: "text", text: `Searching project facts: "${query}"...` }], details: { phase: "search" } });
          const data = await apiPost("/api/project_memory/search", {
            query: query!,
            project_id: projectId,
            category: "facts",
            limit,
          });
          records = data.hits || [];
        }

        if (records.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant project facts found." }],
            details: { project_id: projectId, hits: 0 },
          };
        }

        const preview = formatListPreview(records, !recent);
        const out = `Found ${records.length} fact(s) for "${projectId}":\n\n${preview}`;
        const clamped = clampTotalText(records, out);
        return {
          content: [{ type: "text", text: clamped }],
          details: { project_id: projectId, hits: records.length },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const display = a.query && !a.recent
        ? (a.query.length > 40 ? a.query.slice(0, 37) + "..." : a.query)
        : "recent";
      return new Text(theme.fg("toolTitle", theme.bold("project_facts ")) + theme.fg("accent", `"${display}"`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as ToolResultDetails;
      if (d?.error) return renderError(theme, d.error);
      const line = theme.fg("success", `${d?.hits ?? 0} facts`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = getTextContent(result);
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("pm", {
    description: "Interactive project memory dashboard: browse, search, add, edit, delete facts and todos.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, "Interactive UI requires TUI mode.", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      const menuItems = [
        "🔍 Search",
        "📚 Browse facts",
        "✅ List todos",
        "➕ Add fact",
        "➕ Add todo",
        "📄 Get record",
        "🗑️ Delete record",
        "🤖 Curate facts",
        "⚙️ Settings",
      ];
      const actionLabel = await ctx.ui.select("Project Memory", menuItems);
      if (!actionLabel) return;
      const action = actionLabel.split(" ").slice(1).join(" ");

      try {
        if (action === "Search") {
          const query = await ctx.ui.input("Search query", "");
          if (!query) return;
          const data = await apiPost("/api/project_memory/search", { project_id: projectId, query, limit: 10 });
          const hits: ApiRecord[] = data.hits || [];
          if (!hits.length) {
            ctx.ui.notify("No results.", "warning");
            return;
          }
          const labels = hits.map((h, i) => formatTuiLabel(h, i));
          const selected = await ctx.ui.select("Search results", labels);
          if (selected) {
            const idx = parseInt(selected.split(".")[0]);
            ctx.ui.notify(formatRecordDetail(hits[idx]), "info");
          }
        } else if (action === "Add fact") {
          const type = (await ctx.ui.select("Type", ["decision", "pattern", "gotcha", "architecture", "bugfix"])) || "decision";
          const topic = await ctx.ui.input("Topic (max 6 words)", "");
          if (!topic) return;
          const what = await ctx.ui.editor("What (one concrete sentence)");
          if (!what) return;
          const why = await ctx.ui.editor("Why (optional)");
          const whereRaw = await ctx.ui.input("Where (comma-separated)", "");
          const where = whereRaw ? whereRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
          const tagsRaw = await ctx.ui.input("Tags (comma-separated)", "");
          const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
          const result: AddResult = await apiPost("/api/project_memory/add", {
            project_id: projectId,
            category: "facts",
            type,
            topic: topic.trim(),
            what: what.trim(),
            why: why?.trim() || "",
            where,
            tags,
          });
          const { message } = formatAddResult(result, topic);
          ctx.ui.notify(message, "info");
        } else if (action === "Add todo") {
          const topic = await ctx.ui.input("Topic (max 6 words)", "");
          if (!topic) return;
          const what = await ctx.ui.editor("What needs to be done?");
          if (!what) return;
          const result = await apiPost("/api/project_memory/add", {
            project_id: projectId,
            category: "todos",
            type: "todo_item",
            topic: topic.trim(),
            what: what.trim(),
            why: "",
            where: [],
            tags: [],
          });
          ctx.ui.notify(`Saved todo "${topic}" (id: ${result.item_id})`, "info");
        } else if (action === "List todos") {
          const data = await apiPost("/api/project_memory/todos", { project_id: projectId, limit: 20 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No todos.", "warning");
            return;
          }
          const labels = records.map((r, i) => formatTuiLabel(r, i, "todo"));
          const selected = await ctx.ui.select("Todos", labels);
          if (selected) {
            const idx = parseInt(selected.split(".")[0]);
            ctx.ui.notify(formatRecordDetail(records[idx]), "info");
          }
        } else if (action === "Get record") {
          const data = await apiPost("/api/project_memory/list_all", { project_id: projectId, limit: 50 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No records found.", "warning");
            return;
          }
          const labels = records.map((r, i) => formatTuiLabel(r, i));
          const selected = await ctx.ui.select("Select a record", labels);
          if (!selected) return;
          const idx = parseInt(selected.split(".")[0]);
          ctx.ui.notify(formatRecordDetail(records[idx]), "info");
        } else if (action === "Browse facts") {
          const data = await apiPost("/api/project_memory/list", { project_id: projectId, category: "facts", limit: 50 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No facts found.", "warning");
            return;
          }
          const labels = records.map((r, i) => formatTuiLabel(r, i));
          const selected = await ctx.ui.select("Facts", labels);
          if (!selected) return;
          const idx = parseInt(selected.split(".")[0]);
          const r = records[idx];
          ctx.ui.notify(formatRecordDetail(r), "info");
          const action2 = await ctx.ui.select(`${r.topic.slice(0, 40)}`, ["✏️ Edit", "🗑️ Delete", "← Back"]);
          if (!action2) return;
          if (action2 === "✏️ Edit") {
            const fields = {
              topic: r.topic,
              what: r.what,
              why: r.why || "",
              where: (r.where || []).join(", "),
              tags: (r.tags || []).join(", "),
            };
            let editing = true;
            while (editing) {
              const preview = (text: string, len = 40) => (text.length > len ? text.slice(0, len) + "..." : text || "(empty)");
              const choice = await ctx.ui.select("Choose field to edit", [
                `Topic: ${preview(fields.topic, 35)}`,
                `What: ${preview(fields.what, 50)}`,
                `Why: ${preview(fields.why, 40)}`,
                `Where: ${preview(fields.where, 35)}`,
                `Tags: ${preview(fields.tags, 35)}`,
                "💾 Save changes",
                "← Cancel",
              ]);
              if (!choice || choice === "← Cancel") return;
              if (choice === "💾 Save changes") {
                editing = false;
                break;
              }
              const fieldName = choice.split(":")[0].toLowerCase();
              if (fieldName === "topic") {
                const val = await ctx.ui.input("Topic (max 6 words)", fields.topic);
                if (val !== undefined) fields.topic = val;
              } else if (fieldName === "what") {
                const val = await ctx.ui.editor("What (one concrete sentence)", fields.what);
                if (val !== undefined) fields.what = val;
              } else if (fieldName === "why") {
                const val = await ctx.ui.editor("Why (optional)", fields.why);
                if (val !== undefined) fields.why = val;
              } else if (fieldName === "where") {
                const val = await ctx.ui.input("Where (comma-separated)", fields.where);
                if (val !== undefined) fields.where = val;
              } else if (fieldName === "tags") {
                const val = await ctx.ui.input("Tags (comma-separated)", fields.tags);
                if (val !== undefined) fields.tags = val;
              }
            }
            const topic = fields.topic.trim();
            const what = fields.what.trim();
            if (!topic || !what) {
              ctx.ui.notify("Topic and What cannot be empty. Update cancelled.", "warning");
              return;
            }
            const where = fields.where ? fields.where.split(",").map((s) => s.trim()).filter(Boolean) : [];
            const tags = fields.tags ? fields.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
            await apiPost("/api/project_memory/update_full", {
              project_id: projectId,
              item_id: r.item_id,
              fields: { topic, what, why: fields.why.trim(), where, tags },
            });
            ctx.ui.notify(`Updated ${r.item_id}`, "info");
          } else if (action2 === "🗑️ Delete") {
            const ok = await ctx.ui.confirm("Delete", `Delete ${r.item_id}?`);
            if (!ok) return;
            await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: r.item_id });
            ctx.ui.notify(`Deleted ${r.item_id}`, "info");
          }
        } else if (action === "Delete record") {
          const data = await apiPost("/api/project_memory/list_all", { project_id: projectId, limit: 50 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No records found.", "warning");
            return;
          }
          const labels = records.map((r, i) => formatTuiLabel(r, i));
          const selected = await ctx.ui.select("Select a record to delete", labels);
          if (!selected) return;
          const idx = parseInt(selected.split(".")[0]);
          const r = records[idx];
          const ok = await ctx.ui.confirm("Delete", `Are you sure you want to delete ${r.item_id}?`);
          if (!ok) return;
          await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: r.item_id });
          ctx.ui.notify(`Deleted ${r.item_id}`, "info");
        } else if (action === "Curate facts") {
          const currentState = getLatestCurateState(ctx);
          const isOn = currentState?.enabled ?? false;
          const powerMenu = isOn ? ["⛔ Turn off curation"] : ["⚡ Turn on curation"];
          const powerChoice = await ctx.ui.select("Project memory curation", powerMenu);
          if (!powerChoice) return;
          if (isOn) {
            pi.appendEntry(PROJECT_MEMORY_CURATE_STATE_TYPE, { enabled: false, mode: null });
            syncProjectMemoryTools(ctx);
            setCurateStatus(ctx, null);
            ctx.ui.notify("Project memory curation OFF", "info");
            return;
          }
          const modeMenu = ["🤖 Auto", "👤 Manual"];
          const modeChoice = await ctx.ui.select("Curation mode", modeMenu);
          if (!modeChoice) return;
          const mode = modeChoice === "🤖 Auto" ? "auto" : "manual";
          pi.appendEntry(PROJECT_MEMORY_CURATE_STATE_TYPE, { enabled: true, mode });
          syncProjectMemoryTools(ctx);
          setCurateStatus(ctx, { enabled: true, mode });
          const prefilled = mode === "auto"
            ? "Review the latest project memory facts. Use curate_facts({ action: 'list' }) to fetch up to 20 facts, inspect the files listed in 'where', then call curate_facts with update/merge/delete for any fact that is stale, duplicate, or incorrect. Leave correct facts untouched. Report a summary of changes with reasons."
            : "Use curate_facts to inspect and manage project memory facts. Ask me before any destructive action (delete/merge) or if a fact's correctness is unclear.";
          ctx.ui.setEditorText(prefilled);
          ctx.ui.notify(`Project memory curation ${mode.toUpperCase()} — edit the prompt and press Enter`, "info");
        } else if (action === "Settings") {
          const settings = getProjectMemorySettings();
          const choice = await ctx.ui.select(
            "Project memory settings",
            [`Debug logging: ${settings.debug ? "ON" : "OFF"}`, "← Back"],
          );
          if (choice === "← Back" || !choice) return;
          settings.debug = !settings.debug;
          await saveProjectMemorySettings(settings);
          ctx.ui.notify(`Debug logging ${settings.debug ? "ON" : "OFF"}`, "info");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Error: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("remember", {
    description: "Save a project fact. Usage: /remember type|topic|what. Types: decision, pattern, gotcha, architecture, bugfix.",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        notify(ctx, "Usage: /remember type|topic|what\nExample: /remember decision|API style|All mutations use POST", "warning");
        return;
      }
      const parts = raw.split("|").map((s) => s.trim());
      if (parts.length !== 3 || parts.some((p) => !p)) {
        notify(ctx, "Usage: /remember type|topic|what", "warning");
        return;
      }
      const [type, topic, what] = parts;
      const valid = new Set(["decision", "pattern", "gotcha", "architecture", "bugfix"]);
      if (!valid.has(type)) {
        notify(ctx, `Invalid type "${type}". Valid: decision, pattern, gotcha, architecture, bugfix`, "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result: AddResult = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: "facts",
          type,
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        const { message } = formatAddResult(result, topic);
        notify(ctx, message, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("todo", {
    description: "Save a project todo. Usage: /todo topic|what.",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        notify(ctx, "Usage: /todo topic|what\nExample: /todo Add tests|Write backend tests for project memory", "warning");
        return;
      }
      const parts = raw.split("|").map((s) => s.trim());
      if (parts.length !== 2 || parts.some((p) => !p)) {
        notify(ctx, "Usage: /todo topic|what", "warning");
        return;
      }
      const [topic, what] = parts;
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: "todos",
          type: "todo_item",
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        notify(ctx, `Saved todo "${topic}" (id: ${result.item_id})`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  // -------------------------------------------------------------------------
  // curate_facts — agent-driven fact curation (manually enabled)
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: CURATE_FACTS_TOOL,
    label: "Curate Project Facts",
    description:
      "Curate saved project facts. List recent facts, then update, merge, or delete ones that are stale, duplicate, or incorrect. Leave correct facts untouched.",
    promptSnippet: "Use when reviewing project memory facts for correctness, freshness, and duplicates.",
    promptGuidelines: [
      "Start with action 'list' to fetch the latest facts (up to 20).",
      "Inspect the files/directories listed in 'where' using normal tools (read, grep, bash).",
      "For correct facts: do nothing.",
      "For outdated or wrong facts: call 'delete' with the item_id.",
      "For duplicate facts: call 'merge' with source_item_id (the worse/older fact) and target_item_id (the better fact). Optionally pass 'fields' to set the merged topic/what/why/where/tags. The source is deleted automatically.",
      "For facts that need editing: call 'update' with item_id and 'fields'.",
      "Always provide a concise reason when updating, merging, or deleting.",
      "Never delete or merge without evidence from the current code or docs.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "One of: list, update, merge, delete.",
      }),
      item_id: Type.Optional(Type.String({ description: "Fact ID for update or delete." })),
      source_item_id: Type.Optional(Type.String({ description: "Source fact ID when merging (the one to remove)." })),
      target_item_id: Type.Optional(Type.String({ description: "Target fact ID when merging (the one to keep)." })),
      reason: Type.Optional(Type.String({ description: "Short reason for update/merge/delete." })),
      fields: Type.Optional(Type.Object({
        topic: Type.Optional(Type.String()),
        what: Type.Optional(Type.String()),
        why: Type.Optional(Type.String()),
        where: Type.Optional(Type.Array(Type.String())),
        tags: Type.Optional(Type.Array(Type.String())),
        type: Type.Optional(Type.String()),
      }, { description: "Updated fields for 'update' or merged fields for 'merge'." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const projectId = await getProjectIdOrError(ctx);
      if (typeof projectId !== "string") return projectId;

      const action = params.action;
      try {
        if (action === "list") {
          const data = await apiPost("/api/project_memory/review_queue", { project_id: projectId, limit: 20 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            return {
              content: [{ type: "text", text: "No facts to review." }],
              details: { project_id: projectId, count: 0 },
            };
          }
          const preview = formatListPreview(records, false);
          const out = `Found ${records.length} fact(s) to review:\n\n${preview}\n\nInspect the files listed in 'where', then call curate_facts with update/merge/delete. Leave correct facts untouched.`;
          return {
            content: [{ type: "text", text: out }],
            details: { project_id: projectId, count: records.length },
          };
        }

        if (action === "update") {
          if (!params.item_id || !params.fields) {
            return errorResult("item_id and fields are required for update");
          }
          const fields: Record<string, unknown> = {};
          if (params.fields.topic !== undefined) fields.topic = params.fields.topic;
          if (params.fields.what !== undefined) fields.what = params.fields.what;
          if (params.fields.why !== undefined) fields.why = params.fields.why;
          if (params.fields.where !== undefined) fields.where = params.fields.where;
          if (params.fields.tags !== undefined) fields.tags = params.fields.tags;
          if (params.fields.type !== undefined) fields.type = params.fields.type;
          await apiPost("/api/project_memory/update_full", { project_id: projectId, item_id: params.item_id, fields });
          return {
            content: [{ type: "text", text: `Updated ${params.item_id}. Reason: ${params.reason || "(none given)"}` }],
            details: { project_id: projectId, item_id: params.item_id, fields },
          };
        }

        if (action === "merge") {
          if (!params.source_item_id || !params.target_item_id) {
            return errorResult("source_item_id and target_item_id are required for merge");
          }
          const data = await apiPost("/api/project_memory/merge", {
            project_id: projectId,
            source_item_id: params.source_item_id,
            target_item_id: params.target_item_id,
            fields: params.fields,
          });
          return {
            content: [{ type: "text", text: `Merged ${params.source_item_id} into ${params.target_item_id}. Reason: ${params.reason || "(none given)"}` }],
            details: {
              project_id: projectId,
              source_item_id: params.source_item_id,
              target_item_id: params.target_item_id,
              result: data,
            },
          };
        }

        if (action === "delete") {
          if (!params.item_id) return errorResult("item_id is required for delete");
          await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: params.item_id });
          return {
            content: [{ type: "text", text: `Deleted ${params.item_id}. Reason: ${params.reason || "(none given)"}` }],
            details: { project_id: projectId, item_id: params.item_id },
          };
        }

        return errorResult(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const action = a.action || "?";
      const id = a.item_id || a.source_item_id || "";
      const display = id ? `${action} ${id}` : action;
      return new Text(theme.fg("toolTitle", theme.bold("curate_facts ")) + theme.fg("accent", display), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as ToolResultDetails;
      if (d?.error) return renderError(theme, d.error);
      const text = getTextContent(result);
      if (!expanded) {
        const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
        return new Text(theme.fg("success", d?.item_id ?? "curate") + theme.fg("dim", ` • ${preview}`), 0, 0);
      }
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(theme.fg("success", d?.item_id ?? "curate") + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // /done — extract facts from current session, review, save
  // -------------------------------------------------------------------------
  function entryToMessage(entry: any): any | undefined {
    if (entry.type === "message" && entry.message) {
      return entry.message;
    }
    if (entry.type === "compaction") {
      return {
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
      };
    }
    return undefined;
  }

  function getSessionMessages(branch: any[]): any[] {
    let compactionIndex = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "compaction") {
        compactionIndex = i;
        break;
      }
    }
    if (compactionIndex < 0) {
      return branch.map(entryToMessage).filter((m): m is any => m !== undefined);
    }
    const compaction = branch[compactionIndex];
    const firstKeptIndex = compaction.type === "compaction"
      ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
      : -1;
    const compactedBranch = [
      compaction,
      ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
      ...branch.slice(compactionIndex + 1),
    ];
    return compactedBranch.map(entryToMessage).filter((m): m is any => m !== undefined);
  }

  function extractToolSummary(toolName: string, details: any): string {
    if (!details || typeof details !== "object") return `tool:${toolName}`;
    const path = details.path || details.file_path || details.url || details.command || details.query || details.pattern;
    if (path) return `tool:${toolName} ${path}`;
    const keys = Object.keys(details).slice(0, 2);
    const args = keys.map((k) => `${k}=${JSON.stringify(details[k])}`).join(" ");
    return args ? `tool:${toolName} ${args}` : `tool:${toolName}`;
  }

  function extractToolSnippet(toolName: string, details: any): string {
    const text = details && typeof details === "object" ? JSON.stringify(details) : String(details || "");
    if (text.length <= 400) return text;
    return text.slice(0, 200) + "\n...[truncated]...\n" + text.slice(-200);
  }

  function truncateAssistantText(text: string, maxChars = 24000): string {
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars / 2));
    const tail = text.slice(-Math.floor(maxChars / 2));
    return `${head}\n\n...[long assistant message truncated]...\n\n${tail}`;
  }

  function formatAssistantMessage(m: any): string {
    const content = Array.isArray(m.content) ? m.content : [];
    const textParts: string[] = [];
    const toolCalls: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block?.type === "toolCall" && block.name) {
        const args = block.arguments || {};
        const target = args.path || args.file_path || args.url || args.command || args.query || args.pattern;
        toolCalls.push(target ? `${block.name} ${target}` : block.name);
      }
      // thinking blocks are intentionally skipped.
    }
    let out = textParts.join("\n\n").trim();
    if (toolCalls.length) {
      const toolLine = `[tools: ${toolCalls.join(", ")}]`;
      out = out ? `${out}\n\n${toolLine}` : toolLine;
    }
    return truncateAssistantText(out);
  }

  async function buildTranscript(ctx: ExtensionCommandContext, includeToolResults = false): Promise<string> {
    const branch = ctx.sessionManager.getBranch();
    const messages = getSessionMessages(branch);
    const llmMessages = convertToLlm(messages);

    const lines: string[] = [];
    for (const rawM of llmMessages) {
      const m = rawM as any;
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        lines.push(`## ${m.role}\n${text}`);
      } else if (m.role === "assistant") {
        lines.push(`## ${m.role}\n${formatAssistantMessage(m)}`);
      } else if (m.role === "toolResult") {
        const toolName = m.toolName || "tool";
        const details = m.details;
        if (includeToolResults) {
          const args = details && typeof details === "object" ? extractToolArgs(details) : "";
          const snippet = extractToolSnippet(toolName, details);
          lines.push(`## toolResult: ${toolName}${args ? ` ${args}` : ""}\n${snippet}`);
        } else {
          lines.push(`## ${extractToolSummary(toolName, details)}`);
        }
      } else {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        lines.push(`## ${m.role}\n${text}`);
      }
    }
    const transcript = lines.join("\n\n");

    // Diagnostic: log rough transcript size and role distribution when debug is enabled.
    const settings = getProjectMemorySettings();
    if (settings.debug) {
      try {
        const diag = llmMessages.map((m: any) => {
          const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return { role: m.role, toolName: m.toolName, len: text.length };
        });
        const logDir = path.join(getAgentDir(), "logs", "project-memory");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          path.join(logDir, `transcript-diag-${Date.now()}.json`),
          JSON.stringify({ total: llmMessages.length, transcriptLen: transcript.length, roles: diag }, null, 2),
          "utf-8",
        );
      } catch {
        // ignore
      }
    }

    return transcript;
  }

  function extractToolArgs(details: any): string {
    if (!details || typeof details !== "object") return "";
    const path = details.path || details.file_path || details.url || details.command || details.query || details.pattern;
    if (path) return String(path);
    const keys = Object.keys(details).slice(0, 2);
    return keys.map((k) => `${k}=${JSON.stringify(details[k])}`).join(" ");
  }

  pi.registerCommand("done", {
    description: "Digest the current session: extract durable facts with a local LLM, review them, and save to project memory.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, "Interactive UI required for /done.", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      if (!hasProjectId(ctx.cwd)) {
        notify(ctx, `Project memory not configured. Create .project-id in ${ctx.cwd}.`, "warning");
        return;
      }

      const transcript = await buildTranscript(ctx);
      if (!transcript.trim()) {
        notify(ctx, "No session history to digest.", "warning");
        return;
      }

      let data: any;
      try {
        ctx.ui.setWorkingMessage("Extracting facts from session...");
        data = await apiPost("/api/project_memory/extract", { project_id: projectId, transcript });
      } catch (err) {
        notifyError(ctx, err);
        return;
      } finally {
        ctx.ui.setWorkingMessage();
      }

      const facts: ExtractedFact[] = (data.facts || []).filter((f: any) => f.fact_type && f.topic && f.what);
      if (facts.length === 0) {
        notify(ctx, "No durable facts found in this session.", "info");
        return;
      }

      ctx.ui.notify(`Found ${facts.length} candidate fact(s).`, "info");

      const choices: string[] = [];
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        choices.push(`${i}. [${f.fact_type}] ${f.topic}`);
      }
      choices.push("Save all");
      choices.push("Discard all");

      const selected = await ctx.ui.select("Select facts to save", choices);
      if (!selected) return;

      const selectedIndices = new Set<number>();
      if (selected === "Save all") {
        for (let i = 0; i < facts.length; i++) selectedIndices.add(i);
      } else if (selected !== "Discard all") {
        const idx = parseInt(selected.split(".")[0]);
        if (!Number.isNaN(idx)) {
          selectedIndices.add(idx);
        }
      }

      if (selectedIndices.size === 0) {
        notify(ctx, "No facts selected.", "info");
        return;
      }

      const saved: string[] = [];
      const skipped: string[] = [];
      for (const idx of selectedIndices) {
        const f = facts[idx];
        try {
          const result: AddResult = await apiPost("/api/project_memory/add", {
            project_id: projectId,
            category: "facts",
            type: f.fact_type,
            topic: f.topic,
            what: f.what,
            why: "",
            where: Array.isArray(f.where) ? f.where : [],
            tags: [],
          });
          if (result.duplicate) {
            skipped.push(`${f.topic} → ${result.item_id}`);
          } else if (result.item_id) {
            saved.push(result.item_id);
          }
        } catch (err) {
          notifyError(ctx, err);
        }
      }

      const parts: string[] = [];
      if (saved.length) parts.push(`Saved ${saved.length} fact(s).\n${saved.join("\n")}`);
      if (skipped.length) parts.push(`Skipped ${skipped.length} duplicate(s):\n${skipped.join("\n")}`);
      notify(ctx, parts.join("\n\n") || "No facts saved.", "info");
    },
  });
}
