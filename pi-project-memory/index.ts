import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = process.env.PI_PROJECT_MEMORY_URL?.trim()
  || process.env.PI_BACKEND_URL?.trim()
  || "http://127.0.0.1:8000";

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
  status?: string;
  created_at?: string;
  updated_at?: string;
  score?: number;
}

interface ToolResultDetails {
  project_id?: string;
  item_id?: string;
  count?: number;
  hits?: number;
  kind?: string;
  phase?: string;
  error?: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolResultDetails;
};

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

async function resolveProjectId(cwd: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(cwd, ".project-id"), "utf-8");
    const id = text.trim().split(/\r?\n/)[0].trim();
    if (id) return id;
  } catch {
    // fall through to fallback
  }
  return path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_") + "_fallback";
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(endpoint: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(endpoint: string, body: unknown): Promise<any> {
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
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRecordPreview(r: ApiRecord, maxLen = 400): string {
  let s = `[${r.category}] ${r.topic}\n${r.what}`;
  if (r.why) s += `\nWhy: ${r.why}`;
  if (r.where?.length) s += `\nWhere: ${r.where.join(", ")}`;
  if (s.length > maxLen) s = s.slice(0, maxLen) + "...";
  return s;
}

function formatRecordDetail(r: ApiRecord): string {
  let out = `## ${r.topic}\n`;
  out += `ID: ${r.item_id}\n`;
  out += `Type: ${r.type} | Category: ${r.category}\n`;
  if (r.status) out += `Status: ${r.status}\n`;
  out += `What: ${r.what}\n`;
  if (r.why) out += `Why: ${r.why}\n`;
  if (r.where?.length) out += `Where: ${r.where.join(", ")}\n`;
  if (r.tags?.length) out += `Tags: ${r.tags.join(", ")}\n`;
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

// ---------------------------------------------------------------------------
// UI helpers for commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool rendering helpers
// ---------------------------------------------------------------------------

function renderError(theme: any, error: string) {
  return new Text(theme.fg("error", `Error: ${error}`), 0, 0);
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((c) => c.type === "text")?.text || "";
}

function renderSummaryLine(theme: any, label: string, value: string, projectId?: string) {
  const line = theme.fg(label === "error" ? "error" : "success", value)
    + (projectId ? theme.fg("muted", ` • ${projectId}`) : "");
  return new Text(line, 0, 0);
}

// ---------------------------------------------------------------------------
// Schema pieces
// ---------------------------------------------------------------------------

const TopicSchema = Type.String({
  minLength: 1,
  maxLength: 120,
  description: "Short topic, max 6 words. Example: 'Runtime dep install path'",
});

const WhatSchema = Type.String({
  minLength: 1,
  maxLength: 800,
  description: "Concrete one-sentence fact. Keep it concise so future agents can scan it quickly.",
});

const WhySchema = Type.Optional(Type.String({
  maxLength: 800,
  description: "Reasoning behind the fact (optional). Explains why the decision was made.",
}));

const WhereSchema = Type.Optional(Type.Array(Type.String(), {
  description: "Relevant file paths (optional). Prefer relative paths from the project root.",
}));

const TagsSchema = Type.Optional(Type.Array(Type.String(), {
  description: "Tags for grouping (optional).",
}));

const FactTypeSchema = Type.Union([
  Type.Literal("decision"),
  Type.Literal("pattern"),
  Type.Literal("gotcha"),
  Type.Literal("architecture"),
  Type.Literal("bugfix"),
], {
  description: "Type of fact. Must be exactly one of: decision, pattern, gotcha, architecture, bugfix. Never use 'feature', 'refactor', 'task', or 'improvement'.",
});

const CategoryFilterSchema = Type.Optional(Type.Union([
  Type.Literal("facts"),
  Type.Literal("handoffs"),
], {
  description: "Optional filter. Only facts and handoffs are indexed and searchable.",
}));

const TodoStatusSchema = Type.Optional(Type.Union([
  Type.Literal("active"),
  Type.Literal("done"),
  Type.Literal("archived"),
], {
  default: "active",
  description: "Filter by status: active, done, or archived.",
}));

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

  // -------------------------------------------------------------------------
  // project_memory_recent
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "project_memory_recent",
    label: "Project Memory Recent",
    description:
      "Get the latest session handoffs and progress for the current project. Use to catch up when a new session starts or the user wants to continue past work.",
    promptSnippet:
      "Call at the start of a new session or when the user says 'continue', 'where did we stop', 'what was I doing'.",
    promptGuidelines: [
      "TRIGGERS — call when: a new session starts, the user says 'continue', 'where did we stop', 'what was I doing', 'catch me up', or 'напомни где мы были'.",
      "SCOPE — uses the current working directory to resolve project_id. Never pass a project_id parameter.",
      "OUTPUT — returns up to 5 short handoff cards. Each card shows its item_id. Read them before asking the user what to do next.",
      "FOLLOW-UP — if a handoff is unclear, call project_memory_get({ item_id: '...' }) using the exact item_id from the card.",
      "NEVER call this when the user asks a specific technical question unrelated to recent work. Use project_memory_search instead.",
    ],
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 5,
        default: 5,
        description: "Max handoff cards (1-5).",
      })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx): Promise<ToolResult> {
      onUpdate?.({ content: [{ type: "text", text: "Loading recent project memory..." }], details: { phase: "load" } });
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/list", {
          project_id: projectId,
          category: "handoffs",
          limit: params.limit ?? 5,
        });
        const records: ApiRecord[] = data.records || [];
        if (records.length === 0) {
          return {
            content: [{ type: "text", text: `No recent handoffs for project "${projectId}".` }],
            details: { project_id: projectId, count: 0 },
          };
        }
        const preview = formatListPreview(records);
        const out = `Recent project memory for "${projectId}" (${records.length} cards):\n\n${preview}\n\nUse project_memory_get({ item_id: "..." }) with the ID shown above to read full detail.`;
        return {
          content: [{ type: "text", text: out }],
          details: { project_id: projectId, count: records.length },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      const l = (args as any).limit ?? 5;
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_recent ")) + theme.fg("accent", `${l}`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as ToolResultDetails;
      if (d?.error) return renderError(theme, d.error);
      const line = theme.fg("success", `${d?.count ?? 0} cards`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = getTextContent(result);
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // project_memory_search
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "project_memory_search",
    label: "Project Memory Search",
    description:
      "Semantic search across accumulated project facts, decisions, patterns, and handoffs. Use when the user asks about conventions, architecture, or 'how do we do X here'.",
    promptSnippet:
      "Call when the user asks about project conventions, past decisions, architecture, or when you are about to read 3+ files just to understand project structure.",
    promptGuidelines: [
      "TRIGGERS — call when: the user asks 'how do we handle X', 'what is our pattern for Y', 'where do we put Z', or 'как у нас сделано'.",
      "SCOPE — searches facts and handoffs only. Todos are NOT indexed; use project_memory_list_todos for tasks.",
      "CATEGORY FILTER — use only when the user explicitly asks for decisions (facts) or session summaries (handoffs). Otherwise leave it empty.",
      "WORKFLOW — one call returns preview hits with item_id and score. Call project_memory_get({ item_id }) only if the preview is not detailed enough.",
      "QUERY QUALITY — use specific technical terms, file names, or framework names. 'TypeBox validation' is better than 'validation'.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 500,
        description: "What to search for. Be specific — use technical terms, file names, or problem descriptions.",
      }),
      category: CategoryFilterSchema,
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Max hits (1-10).",
      })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx): Promise<ToolResult> {
      onUpdate?.({ content: [{ type: "text", text: `Searching project memory: "${params.query}"...` }], details: { phase: "search" } });
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/search", {
          query: params.query,
          project_id: projectId,
          category: params.category || undefined,
          limit: params.limit ?? 5,
        });
        const hits: ApiRecord[] = data.hits || [];
        if (hits.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant project memory found. Try a different query or ask the user to save more facts." }],
            details: { project_id: projectId, hits: 0 },
          };
        }
        const preview = formatListPreview(hits, true);
        const out = `Found ${hits.length} relevant fact(s) for "${projectId}":\n\n${preview}\n\nUse project_memory_get({ item_id: "..." }) with the ID shown above to read full detail.`;
        return {
          content: [{ type: "text", text: out }],
          details: { project_id: projectId, hits: hits.length },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      const q = (args as any).query || "";
      const display = q.length > 40 ? q.slice(0, 37) + "..." : q;
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_search ")) + theme.fg("accent", `"${display}"`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as ToolResultDetails;
      if (d?.error) return renderError(theme, d.error);
      const line = theme.fg("success", `${d?.hits ?? 0} hits`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = getTextContent(result);
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // project_memory_get
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "project_memory_get",
    label: "Project Memory Get",
    description: "Read the full detail of a specific project memory record by item_id. Use as a follow-up to search or recent.",
    promptSnippet: "Second step after project_memory_search or project_memory_recent. Use the exact item_id from the previous result.",
    promptGuidelines: [
      "TRIGGERS — call when the preview from project_memory_search or project_memory_recent is not detailed enough to answer or act.",
      "INPUT — pass the exact item_id string shown in the previous result. Do not guess IDs.",
      "NEVER call this without a concrete item_id from a previous tool result.",
    ],
    parameters: Type.Object({
      item_id: Type.String({
        minLength: 1,
        description: "Exact item_id from a previous search or recent result.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/get", { project_id: projectId, item_id: params.item_id });
        const r: ApiRecord = data.record;
        return {
          content: [{ type: "text", text: formatRecordDetail(r) }],
          details: { item_id: r.item_id, project_id: projectId },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_get ")) + theme.fg("accent", (args as any).item_id || "?"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as ToolResultDetails;
      if (d?.error) return renderError(theme, d.error);
      const text = getTextContent(result);
      if (!expanded) {
        const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
        return new Text(theme.fg("success", d?.item_id ?? "record") + theme.fg("dim", ` • ${preview}`), 0, 0);
      }
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(theme.fg("success", d?.item_id ?? "record") + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // project_memory_save
  // -------------------------------------------------------------------------
  const SaveKindSchema = Type.Union([
    Type.Literal("fact"),
    Type.Literal("handoff"),
    Type.Literal("todo"),
  ], {
    description: "What to save: fact (eternal knowledge), handoff (session summary), or todo (open task).",
  });

  pi.registerTool({
    name: "project_memory_save",
    label: "Project Memory Save",
    description:
      "Save a project record: a fact/decision/pattern/gotcha, a session handoff, or an open todo. Choose the right kind and fill only the fields relevant to that kind.",
    promptSnippet:
      "Use kind='fact' for decisions/patterns/gotchas, kind='handoff' for session summaries, kind='todo' for open tasks.",
    promptGuidelines: [
      "FACT — kind='fact', fact_type=decision|pattern|gotcha|architecture|bugfix. Use after architectural decisions, refactors, bugfixes, or when the user says 'remember'/'запомни'/'сохрани'.",
      "HANDOFF — kind='handoff'. Use at the end of a meaningful session or when the user asks to save progress. Handoffs rotate (last 30 kept). Do not use for eternal facts.",
      "TODO — kind='todo'. Use when the user mentions a follow-up task or you discover unfinished work. Todos are not indexed.",
      "TOPIC — keep under 6 words. Examples: 'Runtime dep install path', 'Auth via credentials provider', 'Session 12'.",
      "WHAT — one or two concrete sentences. Not 'we discussed auth', but 'Auth uses NextAuth credentials provider with bcrypt hashing'.",
      "FACT_TYPE MAPPING — 'we added a feature' → pattern (how it's built) or architecture (structural change). 'bug fixed' → bugfix. 'design choice' → decision. 'non-obvious trap' → gotcha. Never use 'feature', 'refactor', 'task', 'improvement'.",
      "WHY/WHERE/TAGS — only for facts. WHERE uses paths relative to the project root. WHY explains reasoning so future agents do not revert the decision.",
      "STATUS — only for todos. Default is 'active'. Use 'done' or 'archived' if the user explicitly marks it so.",
    ],
    parameters: Type.Object({
      kind: SaveKindSchema,
      topic: TopicSchema,
      what: WhatSchema,
      fact_type: Type.Optional(FactTypeSchema),
      why: WhySchema,
      where: WhereSchema,
      tags: TagsSchema,
      status: Type.Optional(Type.Union([
        Type.Literal("active"),
        Type.Literal("done"),
        Type.Literal("archived"),
      ], {
        default: "active",
        description: "Initial status for todos. Ignored for facts and handoffs.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        let category: string;
        let type: string;
        let why = "";
        let where: string[] = [];
        let tags: string[] = [];
        let status = "active";
        let label = "";

        switch (params.kind) {
          case "fact": {
            if (!params.fact_type) {
              return errorResult("'fact_type' is required when kind='fact'. Use decision, pattern, gotcha, architecture, or bugfix.");
            }
            category = "facts";
            type = params.fact_type;
            why = params.why || "";
            where = params.where || [];
            tags = params.tags || [];
            label = "fact";
            break;
          }
          case "handoff": {
            category = "handoffs";
            type = "progress";
            label = "handoff";
            break;
          }
          case "todo": {
            category = "todos";
            type = "todo_item";
            status = params.status ?? "active";
            label = "todo";
            break;
          }
        }

        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category,
          type,
          topic: params.topic,
          what: params.what,
          why,
          where,
          tags,
          status,
        });
        return {
          content: [{ type: "text", text: `Saved ${label}: ${params.topic} (id: ${result.item_id})` }],
          details: { item_id: result.item_id, project_id: projectId, kind: params.kind },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      const a = args as any;
      const kind = a.kind || "?";
      const t = a.topic || "";
      const display = t.length > 25 ? t.slice(0, 22) + "..." : t;
      return new Text(theme.fg("toolTitle", theme.bold(`project_memory_save ${kind} `)) + theme.fg("accent", display), 0, 0);
    },
    renderResult(result, _options, theme) {
      const d = result.details as ToolResultDetails & { kind?: string };
      if (d?.error) return renderError(theme, d.error);
      return new Text(theme.fg("success", `saved ${d?.kind ?? "record"}`) + theme.fg("muted", ` • ${d?.item_id ?? ""}`), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // project_memory_list_todos
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "project_memory_list_todos",
    label: "Project Memory Todos",
    description: "List open (or done) todo items for the current project. Use when the user asks what else needs to be done.",
    promptSnippet: "Call when the user asks 'what else needs to be done', 'what was left', 'show todos', or 'что осталось'.",
    promptGuidelines: [
      "TRIGGERS — call when: the user asks about remaining work, what's next, open tasks, or todos.",
      "STATUS — default 'active'. Use 'done' only if the user explicitly asks for completed todos.",
      "SCOPE — todos are not searchable via project_memory_search. Use this tool for all todo queries.",
    ],
    parameters: Type.Object({
      status: TodoStatusSchema,
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 50,
        default: 20,
        description: "Max todos to return (1-50).",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/todos", {
          project_id: projectId,
          status: params.status ?? "active",
          limit: params.limit ?? 20,
        });
        const records: ApiRecord[] = data.records || [];
        if (records.length === 0) {
          return {
            content: [{ type: "text", text: `No ${params.status ?? "active"} todos for "${projectId}".` }],
            details: { project_id: projectId, count: 0 },
          };
        }
        const lines = records
          .map((r, i) => `${i + 1}. [${r.status}] ${r.topic}\n   ${r.what}\n   ID: ${r.item_id}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `Todos for "${projectId}" (${records.length}):\n\n${lines}` }],
          details: { project_id: projectId, count: records.length },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderCall(args, theme) {
      const s = (args as any).status ?? "active";
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_todos ")) + theme.fg("accent", s), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as ToolResultDetails;
      if (d?.error) return renderError(theme, d.error);
      const line = theme.fg("success", `${d?.count ?? 0} todos`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = getTextContent(result);
      const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("pm-status", {
    description: "Show project memory status",
    handler: async (_args, ctx) => {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiGet("/api/project_memory/status");
        const counts = data.projects?.[projectId] || { facts: 0, handoffs: 0, todos: 0 };
        notify(ctx, `Project: ${projectId}\nFacts: ${counts.facts} | Handoffs: ${counts.handoffs} | Todos: ${counts.todos}`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-recent", {
    description: "Show recent project handoffs (usage: /pm-recent [N])",
    handler: async (args, ctx) => {
      const projectId = await resolveProjectId(ctx.cwd);
      const limit = Math.max(1, Math.min(parseInt(args.trim()) || 5, 5));
      try {
        const data = await apiPost("/api/project_memory/list", { project_id: projectId, category: "handoffs", limit });
        const records: ApiRecord[] = data.records || [];
        if (records.length === 0) {
          notify(ctx, `No recent handoffs for "${projectId}".`, "warning");
          return;
        }
        const out = `Recent handoffs for "${projectId}":\n\n` + records.map((r) => `- ${r.item_id}: ${r.topic}\n  ${r.what}`).join("\n");
        notify(ctx, out, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-todos", {
    description: "Show project todos (usage: /pm-todos [active|done|archived])",
    handler: async (args, ctx) => {
      const projectId = await resolveProjectId(ctx.cwd);
      const status = ["active", "done", "archived"].includes(args.trim()) ? args.trim() : "active";
      try {
        const data = await apiPost("/api/project_memory/todos", { project_id: projectId, status, limit: 20 });
        const records: ApiRecord[] = data.records || [];
        if (records.length === 0) {
          notify(ctx, `No ${status} todos for "${projectId}".`, "warning");
          return;
        }
        const out = `${status} todos for "${projectId}":\n\n` + records.map((r) => `- ${r.item_id}: [${r.status}] ${r.topic}\n  ${r.what}`).join("\n");
        notify(ctx, out, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-search", {
    description: "Search project memory (usage: /pm-search <query>)",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        notify(ctx, "Usage: /pm-search <query>", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/search", { project_id: projectId, query, limit: 5 });
        const hits: ApiRecord[] = data.hits || [];
        if (hits.length === 0) {
          notify(ctx, `No results for "${query}".`, "warning");
          return;
        }
        const out = `Search results for "${query}":\n\n` + hits.map((h) => `- ${h.item_id} [${h.category}] ${h.topic} (${(h.score ?? 0).toFixed(2)})\n  ${h.what}`).join("\n");
        notify(ctx, out, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  function parsePipeArgs(raw: string, expected: number): string[] | null {
    const parts = raw.split("|").map((s) => s.trim());
    if (parts.length !== expected || parts.some((p) => !p)) return null;
    return parts;
  }

  pi.registerCommand("pm-add-fact", {
    description: "Save a project fact (usage: /pm-add-fact type|topic|what)",
    handler: async (args, ctx) => {
      const parts = parsePipeArgs(args.trim(), 3);
      if (!parts) {
        notify(ctx, "Usage: /pm-add-fact type|topic|what\nTypes: decision, pattern, gotcha, architecture, bugfix\nExample: /pm-add-fact decision|API style|All mutations use POST", "warning");
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
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: "facts",
          type,
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        notify(ctx, `Saved fact "${topic}" (id: ${result.item_id})`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-add-handoff", {
    description: "Save a session handoff (usage: /pm-add-handoff topic|what)",
    handler: async (args, ctx) => {
      const parts = parsePipeArgs(args.trim(), 2);
      if (!parts) {
        notify(ctx, "Usage: /pm-add-handoff topic|what\nExample: /pm-add-handoff Session 3|Refactored indexer and added tests", "warning");
        return;
      }
      const [topic, what] = parts;
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: "handoffs",
          type: "progress",
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        notify(ctx, `Saved handoff "${topic}" (id: ${result.item_id})`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-add-todo", {
    description: "Save a project todo (usage: /pm-add-todo topic|what)",
    handler: async (args, ctx) => {
      const parts = parsePipeArgs(args.trim(), 2);
      if (!parts) {
        notify(ctx, "Usage: /pm-add-todo topic|what\nExample: /pm-add-todo Add tests|Write backend tests for project memory", "warning");
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

  // Legacy alias for muscle memory.
  pi.registerCommand("pm-add", {
    description: "Save a fact or todo (usage: /pm-add type|topic|what). Prefer /pm-add-fact, /pm-add-handoff, or /pm-add-todo.",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        notify(ctx, "Usage: /pm-add type|topic|what. Prefer /pm-add-fact, /pm-add-handoff, or /pm-add-todo.", "warning");
        return;
      }
      const parts = parsePipeArgs(raw, 3);
      if (!parts) {
        notify(ctx, "Usage: /pm-add type|topic|what\nExample: /pm-add decision|API style|All mutations use POST", "warning");
        return;
      }
      const [type, topic, what] = parts;
      const validTypes = new Set(["decision", "pattern", "gotcha", "architecture", "progress", "todo_item", "bugfix"]);
      if (!validTypes.has(type)) {
        notify(ctx, `Invalid type "${type}". Valid: decision, pattern, gotcha, architecture, progress, todo_item, bugfix`, "warning");
        return;
      }
      const category = type === "todo_item" ? "todos" : type === "progress" ? "handoffs" : "facts";
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category,
          type,
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        notify(ctx, `Saved ${category.slice(0, -1)} "${topic}" (id: ${result.item_id})`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-handoff", {
    description: "Save a session handoff (usage: /pm-handoff topic|what). Alias for /pm-add-handoff.",
    handler: async (args, ctx) => {
      // Reuse the same handler object by looking it up would require storing it.
      // Just duplicate the small body.
      const parts = parsePipeArgs(args.trim(), 2);
      if (!parts) {
        notify(ctx, "Usage: /pm-handoff topic|what\nExample: /pm-handoff Session 3|Refactored indexer and added tests", "warning");
        return;
      }
      const [topic, what] = parts;
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: "handoffs",
          type: "progress",
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        notify(ctx, `Saved handoff "${topic}" (id: ${result.item_id})`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-get", {
    description: "Read full detail of a project memory record (usage: /pm-get <item_id>)",
    handler: async (args, ctx) => {
      const itemId = args.trim();
      if (!itemId) {
        notify(ctx, "Usage: /pm-get <item_id>", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/get", { project_id: projectId, item_id: itemId });
        notify(ctx, formatRecordDetail(data.record), "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-update", {
    description: "Update status of a record (usage: /pm-update <item_id> <status>)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        notify(ctx, "Usage: /pm-update <item_id> <status>", "warning");
        return;
      }
      const [itemId, status] = parts;
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        await apiPost("/api/project_memory/update", { project_id: projectId, item_id: itemId, status });
        notify(ctx, `Updated ${itemId} → ${status}`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  pi.registerCommand("pm-delete", {
    description: "Delete a project memory record (usage: /pm-delete <item_id>)",
    handler: async (args, ctx) => {
      const itemId = args.trim();
      if (!itemId) {
        notify(ctx, "Usage: /pm-delete <item_id>", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: itemId });
        notify(ctx, `Deleted ${itemId}`, "info");
      } catch (err) {
        notifyError(ctx, err);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Interactive dashboard
  // -------------------------------------------------------------------------
  pi.registerCommand("pm", {
    description: "Interactive project memory dashboard (TUI)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, "Interactive UI requires TUI mode. Use individual /pm-* commands instead.", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      const menuItems = [
        "📊 Status",
        "📜 Recent handoffs",
        "🔍 Search",
        "📚 Browse facts",
        "➕ Add fact",
        "➕ Add handoff",
        "➕ Add todo",
        "✅ List todos",
        "📄 Get record",
        "✏️ Update status",
        "🗑️ Delete record",
      ];
      const actionLabel = await ctx.ui.select("Project Memory", menuItems);
      if (!actionLabel) return;
      const action = actionLabel.split(" ").slice(1).join(" ");

      try {
        if (action === "Status") {
          const data = await apiGet("/api/project_memory/status");
          const counts = data.projects?.[projectId] || { facts: 0, handoffs: 0, todos: 0 };
          ctx.ui.notify(`Project: ${projectId}\nFacts: ${counts.facts} | Handoffs: ${counts.handoffs} | Todos: ${counts.todos}`, "info");
        } else if (action === "Recent handoffs") {
          const raw = await ctx.ui.input("How many handoffs?", "5");
          const limit = Math.max(1, Math.min(parseInt(raw || "5") || 5, 5));
          const data = await apiPost("/api/project_memory/list", { project_id: projectId, category: "handoffs", limit });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No recent handoffs.", "warning");
            return;
          }
          const labels = records.map((r, i) => `${i}. ${r.item_id}: ${r.topic.slice(0, 40)}`);
          const selected = await ctx.ui.select("Recent handoffs", labels);
          if (selected) {
            const idx = parseInt(selected.split(".")[0]);
            ctx.ui.notify(formatRecordDetail(records[idx]), "info");
          }
        } else if (action === "Search") {
          const query = await ctx.ui.input("Search query", "");
          if (!query) return;
          const data = await apiPost("/api/project_memory/search", { project_id: projectId, query, limit: 10 });
          const hits: ApiRecord[] = data.hits || [];
          if (!hits.length) {
            ctx.ui.notify("No results.", "warning");
            return;
          }
          const labels = hits.map((h, i) => `${i}. ${h.item_id} [${h.category}] ${h.topic.slice(0, 40)}`);
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
          const result = await apiPost("/api/project_memory/add", {
            project_id: projectId,
            category: "facts",
            type,
            topic: topic.trim(),
            what: what.trim(),
            why: why?.trim() || "",
            where,
            tags,
          });
          ctx.ui.notify(`Saved fact "${topic}" (id: ${result.item_id})`, "info");
        } else if (action === "Add handoff") {
          const topic = await ctx.ui.input("Topic (e.g. Session 12)", "");
          if (!topic) return;
          const what = await ctx.ui.editor("What was done and what is next?");
          if (!what) return;
          const result = await apiPost("/api/project_memory/add", {
            project_id: projectId,
            category: "handoffs",
            type: "progress",
            topic: topic.trim(),
            what: what.trim(),
            why: "",
            where: [],
            tags: [],
          });
          ctx.ui.notify(`Saved handoff "${topic}" (id: ${result.item_id})`, "info");
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
          const status = (await ctx.ui.select("Status", ["active", "done", "archived"])) || "active";
          const data = await apiPost("/api/project_memory/todos", { project_id: projectId, status, limit: 20 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify(`No ${status} todos.`, "warning");
            return;
          }
          const labels = records.map((r, i) => `${i}. ${r.item_id}: [${r.status}] ${r.topic.slice(0, 40)}`);
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
          const labels = records.map((r, i) => `${i}. ${r.item_id} [${r.category}] ${r.topic.slice(0, 40)}`);
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
          const labels = records.map((r, i) => `${i}. ${r.item_id}: ${r.topic.slice(0, 40)}`);
          const selected = await ctx.ui.select("Facts", labels);
          if (!selected) return;
          const idx = parseInt(selected.split(".")[0]);
          const r = records[idx];
          const action2 = await ctx.ui.select(`${r.topic.slice(0, 40)}`, ["✏️ Edit", "🗑️ Delete", "← Back"]);
          if (!action2) return;
          if (action2 === "✏️ Edit") {
            const topic = await ctx.ui.input("Topic", r.topic);
            if (!topic) return;
            const what = await ctx.ui.editor("What", r.what);
            if (!what) return;
            const why = await ctx.ui.editor("Why (optional)", r.why || "");
            const whereRaw = await ctx.ui.input("Where (comma-separated)", (r.where || []).join(", "));
            const where = whereRaw ? whereRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
            const tagsRaw = await ctx.ui.input("Tags (comma-separated)", (r.tags || []).join(", "));
            const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
            await apiPost("/api/project_memory/update_full", {
              project_id: projectId,
              item_id: r.item_id,
              fields: { topic: topic.trim(), what: what.trim(), why: why?.trim() || "", where, tags },
            });
            ctx.ui.notify(`Updated ${r.item_id}`, "info");
          } else if (action2 === "🗑️ Delete") {
            const ok = await ctx.ui.confirm("Delete", `Delete ${r.item_id}?`);
            if (!ok) return;
            await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: r.item_id });
            ctx.ui.notify(`Deleted ${r.item_id}`, "info");
          }
        } else if (action === "Update status") {
          const data = await apiPost("/api/project_memory/list_all", { project_id: projectId, limit: 50 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No records found.", "warning");
            return;
          }
          const labels = records.map((r, i) => `${i}. ${r.item_id} [${r.category}] ${r.topic.slice(0, 40)}`);
          const selected = await ctx.ui.select("Select a record", labels);
          if (!selected) return;
          const idx = parseInt(selected.split(".")[0]);
          const r = records[idx];
          const status = (await ctx.ui.select("New status", ["active", "done", "archived"])) || "active";
          await apiPost("/api/project_memory/update", { project_id: projectId, item_id: r.item_id, status });
          ctx.ui.notify(`Updated ${r.item_id} → ${status}`, "info");
        } else if (action === "Delete record") {
          const data = await apiPost("/api/project_memory/list_all", { project_id: projectId, limit: 50 });
          const records: ApiRecord[] = data.records || [];
          if (!records.length) {
            ctx.ui.notify("No records found.", "warning");
            return;
          }
          const labels = records.map((r, i) => `${i}. ${r.item_id} [${r.category}] ${r.topic.slice(0, 40)}`);
          const selected = await ctx.ui.select("Select a record to delete", labels);
          if (!selected) return;
          const idx = parseInt(selected.split(".")[0]);
          const r = records[idx];
          const ok = await ctx.ui.confirm("Delete", `Are you sure you want to delete ${r.item_id}?`);
          if (!ok) return;
          await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: r.item_id });
          ctx.ui.notify(`Deleted ${r.item_id}`, "info");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Error: ${msg}`, "error");
      }
    },
  });
}
