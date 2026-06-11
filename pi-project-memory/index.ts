import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import fs from "node:fs/promises";

const BASE_URL = "http://127.0.0.1:8000";

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

async function resolveProjectId(cwd: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(cwd, ".project-id"), "utf-8");
    const id = text.trim().split(/\r?\n/)[0].trim();
    if (id) return id;
  } catch {
    // fall through
  }
  return path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_") + "_fallback";
}

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

function formatRecordPreview(r: ApiRecord, maxLen = 400): string {
  let s = `[${r.category}] ${r.topic}\n${r.what}`;
  if (r.why) s += `\nWhy: ${r.why}`;
  if (r.where?.length) s += `\nWhere: ${r.where.join(", ")}`;
  if (s.length > maxLen) s = s.slice(0, maxLen) + "...";
  return s;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "project_memory_recent",
    label: "Project Memory Recent",
    description:
      "Get the latest session handoffs and progress for the current project. Use to catch up when a new session starts or the user wants to continue past work.",
    promptSnippet:
      "Call at the start of a new session or when the user says 'continue', 'where did we stop', 'what was I doing'.",
    promptGuidelines: [
      "TRIGGERS — call when: new session starts, user says 'continue', 'where did we stop', 'what was I doing', 'catch me up', 'напомни где мы были'.",
      "SCOPE — uses current working directory to resolve project_id. No project_id parameter needed.",
      "OUTPUT — returns 3-5 short handoff cards with topic + what. Read them carefully before asking the user what to do next.",
      "NEVER call when the user asks a specific technical question that is unrelated to recent work (use search instead).",
    ],
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Max handoff cards (1-10)." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
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
        let out = `Recent project memory for "${projectId}" (${records.length} cards):\n\n`;
        for (let i = 0; i < records.length; i++) {
          out += `--- ${i} ---\n${formatRecordPreview(records[i])}\n\n`;
        }
        out += `Use project_memory_get({ item_id: "..." }) to read full detail if needed.`;
        return {
          content: [{ type: "text", text: out }],
          details: { project_id: projectId, count: records.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
      }
    },
    renderCall(args, theme) {
      const l = (args as any).limit ?? 5;
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_recent ")) + theme.fg("accent", `${l}`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      const line = theme.fg("success", `${d?.count ?? 0} cards`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = result.content.find((c: any) => c.type === "text")?.text || "";
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  pi.registerTool({
    name: "project_memory_search",
    label: "Project Memory Search",
    description:
      "Semantic search across accumulated project facts, decisions, and patterns. Use when the user asks about conventions, architecture, or 'how do we do X here'.",
    promptSnippet:
      "Call when the user asks about project conventions, past decisions, architecture, or when you are about to read 3+ files just to understand project structure.",
    promptGuidelines: [
      "TRIGGERS — call when: user asks 'how do we handle X', 'what is our pattern for Y', 'where do we put Z', 'как у нас сделано'.",
      "SCOPE — searches facts + handoffs for the current project by default. Use category filter only if the user explicitly asks for decisions or todos.",
      "WORKFLOW — one call returns preview hits. Follow up with project_memory_get({ item_id }) if the summary is not enough.",
      "QUERY QUALITY — use specific technical terms, file names, or framework names. 'TypeBox validation' is better than 'validation'.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to search for. Be specific — use technical terms, file names, or problem descriptions." }),
      category: Type.Optional(Type.String({ description: "Optional filter: facts, handoffs, or todos." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Max hits (1-10)." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
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
            content: [{ type: "text", text: "No relevant project memory found. Try a different query or the user may need to save more facts." }],
            details: { project_id: projectId, hits: 0 },
          };
        }
        let out = `Found ${hits.length} relevant fact(s) for "${projectId}":\n\n`;
        for (let i = 0; i < hits.length; i++) {
          const h = hits[i];
          out += `--- Hit ${i} ---\n[${h.category}] [Score: ${(h.score ?? 0).toFixed(3)}] ${h.topic}\n${h.what}\n\n`;
        }
        out += `Use project_memory_get({ item_id: "..." }) to read full detail.`;
        return {
          content: [{ type: "text", text: out }],
          details: { project_id: projectId, hits: hits.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
      }
    },
    renderCall(args, theme) {
      const q = (args as any).query || "";
      const display = q.length > 40 ? q.slice(0, 37) + "..." : q;
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_search ")) + theme.fg("accent", `"${display}"`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      const line = theme.fg("success", `${d?.hits ?? 0} hits`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = result.content.find((c: any) => c.type === "text")?.text || "";
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  pi.registerTool({
    name: "project_memory_get",
    label: "Project Memory Get",
    description: "Read the full detail of a specific project memory record by item_id. Use as a follow-up to search or recent.",
    promptSnippet: "Second step after project_memory_search or project_memory_recent. Use item_id from the result.",
    promptGuidelines: [
      "ALWAYS call this after search/recent if the summary is not enough to act.",
      "Pass the exact item_id string from the previous result.",
    ],
    parameters: Type.Object({
      item_id: Type.String({ description: "Exact item_id from a previous search or recent result." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/get", { project_id: projectId, item_id: params.item_id });
        const r: ApiRecord = data.record;
        let out = `## ${r.topic}\n`;
        out += `Type: ${r.type} | Category: ${r.category}\n`;
        out += `What: ${r.what}\n`;
        if (r.why) out += `Why: ${r.why}\n`;
        if (r.where?.length) out += `Where: ${r.where.join(", ")}\n`;
        if (r.tags?.length) out += `Tags: ${r.tags.join(", ")}\n`;
        out += `ID: ${r.item_id}`;
        return {
          content: [{ type: "text", text: out }],
          details: { item_id: r.item_id, project_id: projectId },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_get ")) + theme.fg("accent", (args as any).item_id || "?"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      const text = result.content.find((c: any) => c.type === "text")?.text || "";
      const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
      return new Text(theme.fg("success", d?.item_id ?? "record") + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  pi.registerTool({
    name: "project_memory_add",
    label: "Project Memory Add",
    description:
      "Save a project fact, decision, pattern, or gotcha so future sessions can find it. Call after completing non-trivial work or when the user says 'remember this'.",
    promptSnippet:
      "Call after making an architectural decision, discovering a non-obvious bug/gotcha, completing a refactor, or when the user says 'remember this'.",
    promptGuidelines: [
      "TRIGGERS — call after: architectural decision, non-obvious bugfix, completed refactor, discovered gotcha, user says 'remember', 'запомни', 'сохрани'.",
      "TOPIC — keep under 6 words. Examples: 'Runtime dep install path', 'Auth via credentials provider'.",
      "WHAT — one concrete sentence. Not 'we discussed auth', but 'Auth uses NextAuth credentials provider with bcrypt hashing'.",
      "WHY — optional but valuable. Explains the reasoning so future agents don't revert the decision.",
      "WHERE — list relevant file paths so future agents know where to look for code or docs.",
      "TYPE — use 'decision' for choices, 'pattern' for recurring conventions, 'gotcha' for non-obvious traps, 'progress' for session outcomes, 'bugfix' for fixed bugs.",
    ],
    parameters: Type.Object({
      type: Type.String({ description: "Type: decision, pattern, gotcha, architecture, progress, todo_item, bugfix" }),
      topic: Type.String({ description: "Short topic, max 6 words. Example: 'Runtime dep install path'" }),
      what: Type.String({ description: "Concrete one-sentence fact." }),
      why: Type.Optional(Type.String({ description: "Reasoning behind the fact (optional)." })),
      where: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths (optional)." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for grouping (optional)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: params.type === "todo_item" ? "todos" : "facts",
          type: params.type,
          topic: params.topic,
          what: params.what,
          why: params.why || "",
          where: params.where || [],
          tags: params.tags || [],
        });
        return {
          content: [{ type: "text", text: `Saved project memory: ${params.topic} (id: ${result.item_id})` }],
          details: { item_id: result.item_id, project_id: projectId },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
      }
    },
    renderCall(args, theme) {
      const t = (args as any).topic || "";
      const display = t.length > 30 ? t.slice(0, 27) + "..." : t;
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_add ")) + theme.fg("accent", display), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      return new Text(theme.fg("success", "saved") + theme.fg("muted", ` • ${d?.item_id ?? ""}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "project_memory_list_todos",
    label: "Project Memory Todos",
    description: "List open (or done) todo items for the current project. Use when the user asks what else needs to be done.",
    promptSnippet: "Call when user asks 'what else needs to be done', 'what was left', 'show todos', or 'что осталось'.",
    promptGuidelines: [
      "TRIGGERS — call when: user asks about remaining work, what's next, open tasks, todos.",
      "STATUS — default 'active'. Use 'done' only if user explicitly asks for completed todos.",
    ],
    parameters: Type.Object({
      status: Type.Optional(Type.String({ default: "active", description: "Filter by status: active, done, archived." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20, description: "Max todos to return." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
        let out = `Todos for "${projectId}" (${records.length}):\n\n`;
        for (let i = 0; i < records.length; i++) {
          out += `${i + 1}. [${records[i].status}] ${records[i].topic}\n   ${records[i].what}\n\n`;
        }
        return {
          content: [{ type: "text", text: out }],
          details: { project_id: projectId, count: records.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
      }
    },
    renderCall(args, theme) {
      const s = (args as any).status ?? "active";
      return new Text(theme.fg("toolTitle", theme.bold("project_memory_todos ")) + theme.fg("accent", s), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      const line = theme.fg("success", `${d?.count ?? 0} todos`) + theme.fg("muted", ` • ${d?.project_id ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = result.content.find((c: any) => c.type === "text")?.text || "";
      const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // Commands

  pi.registerCommand("pm-status", {
    description: "Show project memory status",
    handler: async (_args, ctx) => {
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiGet("/api/project_memory/status");
        const counts = data.projects?.[projectId] || { facts: 0, handoffs: 0, todos: 0 };
        const msg = `Project: ${projectId}\nFacts: ${counts.facts} | Handoffs: ${counts.handoffs} | Todos: ${counts.todos}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "pm-status", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-status", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-recent", {
    description: "Show recent project handoffs (usage: /pm-recent [N])",
    handler: async (args, ctx) => {
      const projectId = await resolveProjectId(ctx.cwd);
      const limit = Math.max(1, Math.min(parseInt(args.trim()) || 5, 20));
      try {
        const data = await apiPost("/api/project_memory/list", { project_id: projectId, category: "handoffs", limit });
        const records: ApiRecord[] = data.records || [];
        if (records.length === 0) {
          const msg = `No recent handoffs for "${projectId}".`;
          if (ctx.hasUI) ctx.ui.notify(msg, "warning");
          else pi.sendMessage({ customType: "pm-recent", content: msg, display: true }, { triggerTurn: false });
          return;
        }
        let out = `Recent handoffs for "${projectId}":\n\n`;
        for (const r of records) {
          out += `- ${r.topic}: ${r.what}\n`;
        }
        if (ctx.hasUI) ctx.ui.notify(out, "info");
        else pi.sendMessage({ customType: "pm-recent", content: out, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-recent", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-todos", {
    description: "Show project todos (usage: /pm-todos [active|done])",
    handler: async (args, ctx) => {
      const projectId = await resolveProjectId(ctx.cwd);
      const status = ["active", "done", "archived"].includes(args.trim()) ? args.trim() : "active";
      try {
        const data = await apiPost("/api/project_memory/todos", { project_id: projectId, status, limit: 20 });
        const records: ApiRecord[] = data.records || [];
        if (records.length === 0) {
          const msg = `No ${status} todos for "${projectId}".`;
          if (ctx.hasUI) ctx.ui.notify(msg, "warning");
          else pi.sendMessage({ customType: "pm-todos", content: msg, display: true }, { triggerTurn: false });
          return;
        }
        let out = `${status} todos for "${projectId}":\n\n`;
        for (const r of records) {
          out += `- ${r.topic}: ${r.what}\n`;
        }
        if (ctx.hasUI) ctx.ui.notify(out, "info");
        else pi.sendMessage({ customType: "pm-todos", content: out, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-todos", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-search", {
    description: "Search project memory (usage: /pm-search <query>)",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /pm-search <query>", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/search", { project_id: projectId, query, limit: 5 });
        const hits: ApiRecord[] = data.hits || [];
        if (hits.length === 0) {
          const msg = `No results for "${query}".`;
          if (ctx.hasUI) ctx.ui.notify(msg, "warning");
          else pi.sendMessage({ customType: "pm-search", content: msg, display: true }, { triggerTurn: false });
          return;
        }
        let out = `Search results for "${query}":\n\n`;
        for (const h of hits) {
          out += `- [${h.category}] ${h.topic} (${(h.score ?? 0).toFixed(2)})\n  ${h.what}\n`;
        }
        if (ctx.hasUI) ctx.ui.notify(out, "info");
        else pi.sendMessage({ customType: "pm-search", content: out, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-search", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-add", {
    description: "Save a fact or todo (usage: /pm-add type|topic|what)",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        const msg = "Usage: /pm-add type|topic|what\nTypes: decision, pattern, gotcha, architecture, progress, todo_item, bugfix";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else pi.sendMessage({ customType: "pm-add", content: msg, display: true }, { triggerTurn: false });
        return;
      }
      const parts = raw.split("|").map((s) => s.trim());
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        const msg = "Usage: /pm-add type|topic|what\nExample: /pm-add decision|API style|All mutations use POST";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else pi.sendMessage({ customType: "pm-add", content: msg, display: true }, { triggerTurn: false });
        return;
      }
      const [type, topic, what] = parts;
      const validTypes = new Set(["decision", "pattern", "gotcha", "architecture", "progress", "todo_item", "bugfix"]);
      if (!validTypes.has(type)) {
        const msg = `Invalid type "${type}". Valid: decision, pattern, gotcha, architecture, progress, todo_item, bugfix`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else pi.sendMessage({ customType: "pm-add", content: msg, display: true }, { triggerTurn: false });
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/add", {
          project_id: projectId,
          category: type === "todo_item" ? "todos" : "facts",
          type,
          topic,
          what,
          why: "",
          where: [],
          tags: [],
        });
        const msg = `Saved ${type} "${topic}" (id: ${result.item_id})`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "pm-add", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-add", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-get", {
    description: "Read full detail of a project memory record (usage: /pm-get <item_id>)",
    handler: async (args, ctx) => {
      const itemId = args.trim();
      if (!itemId) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /pm-get <item_id>", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const data = await apiPost("/api/project_memory/get", { project_id: projectId, item_id: itemId });
        const r: ApiRecord = data.record;
        let out = `## ${r.topic}\nType: ${r.type} | Category: ${r.category}\nWhat: ${r.what}\n`;
        if (r.why) out += `Why: ${r.why}\n`;
        if (r.where?.length) out += `Where: ${r.where.join(", ")}\n`;
        if (r.tags?.length) out += `Tags: ${r.tags.join(", ")}\n`;
        out += `ID: ${r.item_id}`;
        if (ctx.hasUI) ctx.ui.notify(out, "info");
        else pi.sendMessage({ customType: "pm-get", content: out, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-get", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-update", {
    description: "Update status of a record (usage: /pm-update <item_id> <status>)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /pm-update <item_id> <status>", "warning");
        return;
      }
      const [itemId, status] = parts;
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        const result = await apiPost("/api/project_memory/update", { project_id: projectId, item_id: itemId, status });
        const msg = `Updated ${itemId} → ${status}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "pm-update", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-update", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-delete", {
    description: "Delete a project memory record (usage: /pm-delete <item_id>)",
    handler: async (args, ctx) => {
      const itemId = args.trim();
      if (!itemId) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /pm-delete <item_id>", "warning");
        return;
      }
      const projectId = await resolveProjectId(ctx.cwd);
      try {
        await apiPost("/api/project_memory/delete", { project_id: projectId, item_id: itemId });
        const msg = `Deleted ${itemId}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "pm-delete", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-delete", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("pm-handoff", {
    description: "Save a session handoff (usage: /pm-handoff topic|what)",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        const msg = "Usage: /pm-handoff topic|what\nExample: /pm-handoff Session 3|Refactored indexer and added tests";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else pi.sendMessage({ customType: "pm-handoff", content: msg, display: true }, { triggerTurn: false });
        return;
      }
      const parts = raw.split("|").map((s) => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        const msg = "Usage: /pm-handoff topic|what\nExample: /pm-handoff Session 3|Refactored indexer and added tests";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else pi.sendMessage({ customType: "pm-handoff", content: msg, display: true }, { triggerTurn: false });
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
        const msg = `Saved handoff "${topic}" (id: ${result.item_id})`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "pm-handoff", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Error: ${msg}`, "error");
        else pi.sendMessage({ customType: "pm-handoff", content: `Error: ${msg}`, display: true }, { triggerTurn: false });
      }
    },
  });
}
