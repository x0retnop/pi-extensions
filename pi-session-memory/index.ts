import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import { exportSessionToMarkdown, groupSessionsByProject, openSessionExportTUI, type ExportFormat } from "./local-export.js";
import { extractProject } from "./project.js";

// Allow runtime injection of a different base URL for tests.
let BASE_URL =
  process.env.PI_SESSION_MEMORY_URL?.trim() ||
  process.env.PI_BACKEND_URL?.trim() ||
  "http://127.0.0.1:8000";

export function setBaseUrl(url: string): void { BASE_URL = url; }
const SEARCH_ENTRY_TYPE = "session-memory-search";

interface SearchHit {
  item_id: string;
  source_path: string;
  text: string;
  score: number;
  date: string;
}

interface StoredSearch {
  hits: SearchHit[];
  timestamp: number;
}

interface SessionListItem {
  source_path: string;
  project: string;
  date: string;
  preview: string;
}

interface StoredList {
  sessions: SessionListItem[];
  timestamp: number;
}

const LIST_ENTRY_TYPE = "session-memory-list";

// ---------------------------------------------------------------------------
// API clients
// ---------------------------------------------------------------------------

export async function apiSearch(
  query: string,
  limit: number,
  scope: "all" | "project" = "project",
  cwd?: string,
  excludeSourcePath?: string,
): Promise<SearchHit[]> {
  const body: Record<string, any> = { query, limit, scope };
  if (cwd) body.cwd = cwd;
  if (excludeSourcePath) body.exclude_source_path = excludeSourcePath;
  const res = await fetch(`${BASE_URL}/api/session_index/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.hits || [];
}

export async function apiSessionContent(
  sourcePath: string,
  maxMessages: number,
  maxChars: number,
  toolResultLimit: number,
): Promise<{
  source_path: string;
  project: string;
  date: string;
  text: string;
  total_messages: number;
  returned_messages: number;
  chars: number;
  truncated: boolean;
}> {
  const res = await fetch(`${BASE_URL}/api/session_index/session_content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_path: sourcePath,
      max_messages: maxMessages,
      max_chars: maxChars,
      tool_result_limit: toolResultLimit,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export async function apiStatus(): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/session_index/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function apiRebuild(): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/session_index/rebuild`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function apiListSessions(
  scope: "project" | "all",
  cwd: string,
  limit = 4,
  excludeSourcePath?: string,
): Promise<SessionListItem[]> {
  const body: Record<string, any> = { scope, cwd, limit };
  if (excludeSourcePath) body.exclude_source_path = excludeSourcePath;
  const res = await fetch(`${BASE_URL}/api/session_index/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.sessions || [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLastSearch(ctx: ExtensionContext): StoredSearch | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any;
    if (e?.type === "custom" && e?.customType === SEARCH_ENTRY_TYPE && e?.data) {
      return e.data as StoredSearch;
    }
  }
  return null;
}

function getLastList(ctx: ExtensionContext): StoredList | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any;
    if (e?.type === "custom" && e?.customType === LIST_ENTRY_TYPE && e?.data) {
      return e.data as StoredList;
    }
  }
  return null;
}

function getLastSearchOrList(ctx: ExtensionContext): StoredSearch | StoredList | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any;
    if (e?.type === "custom" && e?.data) {
      if (e?.customType === SEARCH_ENTRY_TYPE) return e.data as StoredSearch;
      if (e?.customType === LIST_ENTRY_TYPE) return e.data as StoredList;
    }
  }
  return null;
}


function formatHitPreview(hit: SearchHit, maxLen: number): string {
  let text = hit.text.trim();
  if (text.length > maxLen) text = text.slice(0, maxLen) + "\n...[truncated]";
  return `[Project: ${extractProject(hit.source_path)}] [Date: ${hit.date || "unknown"}] [Score: ${hit.score.toFixed(3)}]\n${text}`;
}

function formatSessionOption(s: SessionListItem): string {
  const date = s.date ? s.date.replace("T", " ").slice(0, 19) : "unknown";
  const id = sessionIdFromPath(s.source_path);
  const preview = (s.preview || "").replace(/\s+/g, " ").trim();
  return `${date}  |  ${id}  |  ${preview}`;
}

function sessionIdFromPath(sourcePath: string): string {
  const name = path.basename(sourcePath, ".jsonl");
  const parts = name.split("_");
  if (parts.length >= 2) {
    return parts[parts.length - 1].slice(0, 8);
  }
  return name.slice(0, 8);
}

function serverUnreachableResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const unreachable =
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("Unable to connect") ||
    msg.includes("Connection refused");
  if (unreachable) {
    return {
      content: [
        {
          type: "text",
          text: `Error: 0x010 server is not running on ${BASE_URL}. Start uvicorn and ensure SESSION_INDEX_ENABLED=true.`,
        },
      ],
      details: { error: "Server unreachable", raw: msg },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    details: { error: msg },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

async function actionSearch(
  params: any,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  onUpdate?: (update: any) => void,
): Promise<any> {
  const scope = params.scope ?? "project";
  const cwd = params.cwd || ctx.cwd || ctx.sessionManager.getCwd();
  const scopeLabel = scope === "all" ? "all projects" : "project tree";
  onUpdate?.({
    content: [{ type: "text", text: `Searching sessions (${scopeLabel}): "${params.query}"...` }],
    details: { phase: "search", scope, cwd },
  });

  const excludeSourcePath = ctx.sessionManager.getSessionFile() || undefined;

  let hits: SearchHit[];
  try {
    hits = await apiSearch(params.query, params.limit ?? 3, scope, cwd, excludeSourcePath);
  } catch (err) {
    return serverUnreachableResult(err);
  }

  const minScore = params.minScore ?? 0.3;
  const filtered = hits.filter((h) => h.score >= minScore);

  if (filtered.length === 0) {
    return {
      content: [
        { type: "text", text: "No relevant sessions found. Try a different query or lower minScore." },
      ],
      details: { hitsCount: hits.length, filteredCount: 0 },
    };
  }

  const stored: StoredSearch = { hits: filtered, timestamp: Date.now() };
  pi.appendEntry(SEARCH_ENTRY_TYPE, stored);

  let output = `Found ${filtered.length} relevant session(s):\n\n`;
  for (let i = 0; i < filtered.length; i++) {
    const h = filtered[i];
    output += `--- Hit ${i} ---\n`;
    output += formatHitPreview(h, 1500);
    output += `\n\nsourcePath: ${h.source_path}\n\n`;
  }

  output += `Use session_memory(action="content", hitIndex=N) to read a specific session with safe limits.`;

  return {
    content: [{ type: "text", text: output }],
    details: { hitsCount: filtered.length, topScore: filtered[0]?.score, queries: [params.query] },
  };
}

async function actionContent(params: any, ctx: ExtensionContext): Promise<any> {
  let sourcePath: string | undefined = params.sourcePath;

  if (!sourcePath && params.hitIndex !== undefined) {
    const last = getLastSearchOrList(ctx);
    if (!last) {
      return {
        content: [
          { type: "text", text: "Error: No recent session_memory search or list found. Run action=search/action=list first or provide sourcePath." },
        ],
        details: { error: "No recent search or list" },
        isError: true,
      };
    }
    const item = "hits" in last ? last.hits[params.hitIndex] : last.sessions[params.hitIndex];
    if (!item) {
      const count = "hits" in last ? last.hits.length : last.sessions.length;
      return {
        content: [
          { type: "text", text: `Error: hitIndex ${params.hitIndex} out of range (0-${count - 1})` },
        ],
        details: { error: "Index out of range" },
        isError: true,
      };
    }
    sourcePath = item.source_path;
  }

  if (!sourcePath) {
    return {
      content: [{ type: "text", text: "Error: Provide sourcePath or hitIndex." }],
      details: { error: "No source specified" },
      isError: true,
    };
  }

  let result: Awaited<ReturnType<typeof apiSessionContent>>;
  try {
    result = await apiSessionContent(
      sourcePath,
      params.maxMessages ?? 30,
      params.maxChars ?? 4000,
      params.toolResultLimit ?? 1000,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading session: ${msg}` }],
      details: { error: msg, sourcePath },
      isError: true,
    };
  }

  const header = `## Session: ${path.basename(sourcePath)}\nProject: ${extractProject(sourcePath)}\nMessages: ${result.returned_messages}/${result.total_messages}${result.truncated ? " (truncated)" : ""}\n\n`;
  return {
    content: [{ type: "text", text: header + result.text }],
    details: { sourcePath, project: extractProject(sourcePath), chars: result.chars, truncated: result.truncated },
  };
}

async function actionFind(
  params: any,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  onUpdate?: (update: any) => void,
): Promise<any> {
  onUpdate?.({
    content: [{ type: "text", text: `Finding session context for: "${params.query}"...` }],
    details: { phase: "find" },
  });

  const searchResult = await actionSearch(
    { ...params, limit: params.limit ?? 1, minScore: params.minScore ?? 0.3 },
    ctx,
    pi,
    onUpdate,
  );

  if (searchResult.isError || (searchResult.details as any)?.error) {
    return searchResult;
  }

  const last = getLastSearch(ctx);
  if (!last || last.hits.length === 0) {
    return {
      content: [{ type: "text", text: "No relevant session found for the query." }],
      details: { found: false },
    };
  }

  // Use hitIndex=0 instead of passing sourcePath. The stored search result keeps
  // the exact source_path, so the LLM cannot truncate or misquote it.
  return actionContent({ hitIndex: 0, ...params }, ctx);
}

async function actionList(
  params: any,
  _ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<any> {
  const cwd = params.cwd || _ctx.cwd || _ctx.sessionManager.getCwd();
  const scope = params.scope ?? "project";
  const excludeSourcePath = _ctx.sessionManager.getSessionFile() || undefined;
  const scopeLabel = scope === "all" ? "all projects" : "project tree";
  const limit = params.limit ?? (params.sessions === "history" ? 10 : 4);

  try {
    const sessions = await apiListSessions(scope, cwd, limit, excludeSourcePath);
    if (sessions.length === 0) {
      return {
        content: [{ type: "text", text: `No saved sessions found for ${scopeLabel}.` }],
        details: { sessionsCount: 0, scope, cwd },
      };
    }

    const stored: StoredList = { sessions, timestamp: Date.now() };
    pi.appendEntry(LIST_ENTRY_TYPE, stored);

    let output = `Recent sessions for ${cwd} (${scopeLabel}):\n\n`;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      output += `[${i}] ${formatSessionOption(s)}\n`;
    }

    output += `\nUse session_memory(action="content", hitIndex=N) to read a specific session.`;
    if (scope === "project") {
      output += ` Use scope="all" to search across every project.`;
    }

    return {
      content: [{ type: "text", text: output }],
      details: { sessionsCount: sessions.length, scope, cwd },
    };
  } catch (err) {
    return serverUnreachableResult(err);
  }
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

const SessionMemoryActionSchema = Type.Union([
  Type.Literal("search"),
  Type.Literal("content"),
  Type.Literal("list"),
  Type.Literal("find"),
]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_memory",
    label: "Session Memory",
    description:
      "Unified access to the user's past conversation history. Search for relevant sessions, list saved sessions, read a specific session safely, or find-and-read the most relevant session in one step.",
    promptSnippet:
      "Use when the user asks about something from a previous conversation, or when a handoff/continuation file refers to details that are only in past sessions. action=search returns preview hits; action=content reads one session; action=list enumerates recent sessions; action=find searches and returns the top matching session content in one call.",
    promptGuidelines: [
      "TRIGGERS — call this tool when the user uses phrases like: 'recall', 'remember', 'where did we', 'how did I before', 'as we discussed earlier', 'in a previous session', 'как я делал раньше', 'в прошлый раз', 'где мы обсуждали', 'напомни', 'найди в историю'.",
      "HANDOFF CONTINUATION — when starting from a handoff/continuation file, scan for the section 'Details to Retrieve from Session History' and for phrases like 'see the previous session', 'see session history', 'details are in the session history', 'the exact output is in the previous session', 'the raw ... is in the session history', 'in the previous session'. For each item, call session_memory(action='find', query='<specific technical detail>') to retrieve the raw detail. Prefer action=find. Do not treat the handoff as the only source of truth. Do not fabricate a sourcePath; let the tool resolve the hit internally.",
      "WORKFLOW — for quick verification use action=find. Use action=search when you want to compare multiple sessions, then action=content with hitIndex for details. Use action=content directly when you already have sourcePath or hitIndex. Never guess from training data.",
      "QUERY QUALITY — for action=search use specific technical terms, file names, error messages, or framework names. Avoid vague single words.",
      "DEFAULT SCOPE — for action=list, action=search and action=find the default scope is 'project' (current cwd plus Pi sub-directories). This matches how the user usually wants 'past sessions for this project'. Use scope='all' only when the user explicitly asks to search across every project or uses phrases like 'anywhere', 'everywhere', 'in all projects', 'I don't remember which project'.",
      "LISTING — use action=list when the user asks to see recent sessions without a specific query. Default limit is 4 and default scope is 'project'. If the user says 'previous session', 'last session', 'что делали в последней сессии', 'что было в прошлый раз', use limit=1. If they say 'recent sessions' or 'past sessions', use the default limit=4. If they say 'session history', 'many sessions' or 'show more sessions', use limit=10. The list output contains compact previews (date + short ID + first user/assistant exchange) so the agent can pick which sessions to read.",
      "READING AFTER LIST OR SEARCH — after action=list or action=search, use session_memory(action='content', hitIndex=N) to read the session at index N. The result is stored in the session, so hitIndex works for both. Do not invent or copy a sourcePath from the output text; always use hitIndex.",
      "SCORE INTERPRETATION — score is cosine similarity [-1, 1]. Higher is better. Values > 0.5 are usually strongly relevant. Compare relative magnitudes within the result set.",
      "LIMITS — action=content uses safe defaults (maxMessages=30, maxChars=4000, toolResultLimit=1000). Increase only if the user explicitly asks for more.",
      "NEVER use the raw read tool on .jsonl session files — they can be 50 MB+. Always use session_memory.",
    ],
    parameters: Type.Object({
      action: SessionMemoryActionSchema,
      query: Type.Optional(
        Type.String({
          description: "Required for action=search and action=find. Be specific — use technical terms, file names, error messages, or problem descriptions.",
        }),
      ),
      sourcePath: Type.Optional(
        Type.String({
          description: "Required for action=content unless hitIndex is provided. Absolute path to the .jsonl session file. Prefer hitIndex; only use sourcePath if you have a full, exact path from a previous tool result and cannot use an index.",
        }),
      ),
      hitIndex: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Index from the last session_memory search or list result (0 = top hit). Use this instead of sourcePath whenever possible.",
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("all")], {
          default: "project",
          description: "'project' = current cwd plus Pi sub-directories (default). 'all' = every indexed session. Use 'all' only when the user explicitly asks to search across all projects.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Override current working directory. Used by action=list to pick the project folder and by action=search/find to restrict the search scope.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          default: 3,
          description: "Max results for search or list.",
        }),
      ),
      minScore: Type.Optional(
        Type.Number({
          minimum: -1,
          maximum: 1,
          default: 0.3,
          description: "Minimum relevance score for action=search. Values > 0.5 are usually strongly relevant.",
        }),
      ),
      maxMessages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1000,
          default: 30,
          description: "For action=content: latest messages to include.",
        }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100000,
          default: 4000,
          description: "For action=content: hard output character limit.",
        }),
      ),
      toolResultLimit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10000,
          default: 1000,
          description: "For action=content: max characters per tool result block to include.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      switch (params.action) {
        case "search":
          if (!params.query?.trim()) {
            return {
              content: [{ type: "text", text: "Error: action=search requires a query parameter." }],
              details: { error: "Missing query" },
              isError: true,
            };
          }
          return actionSearch(params, ctx, pi, onUpdate);
        case "content":
          return actionContent(params, ctx);
        case "list":
          return actionList(params, ctx, pi);
        case "find":
          if (!params.query?.trim()) {
            return {
              content: [{ type: "text", text: "Error: action=find requires a query parameter." }],
              details: { error: "Missing query" },
              isError: true,
            };
          }
          return actionFind(params, ctx, pi, onUpdate);
        default:
          return {
            content: [{ type: "text", text: `Error: unknown action "${params.action}". Use search, content, list, or find.` }],
            details: { error: "Unknown action" },
            isError: true,
          };
      }
    },

    renderCall(args, theme) {
      const a = args as any;
      const action = a.action || "?";
      let detail = "";
      if (action === "search" || action === "find") detail = a.query || "";
      else if (action === "content") detail = a.sourcePath ? path.basename(a.sourcePath) : `hitIndex=${a.hitIndex ?? "?"}`;
      else if (action === "list") detail = a.scope || "project";
      if (detail.length > 40) detail = detail.slice(0, 37) + "...";
      return new Text(theme.fg("toolTitle", theme.bold("session_memory ")) + theme.fg("accent", `${action} ${detail}`), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) {
        return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      }
      let line = theme.fg("success", "ok");
      if (typeof d?.hitsCount === "number") {
        line = d.hitsCount === 0 ? theme.fg("muted", "0 hits") : theme.fg("success", `${d.hitsCount} hits`) + theme.fg("muted", ` • top score ${(d?.topScore ?? 0).toFixed(3)}`);
      } else if (typeof d?.sessionsCount === "number") {
        line = theme.fg("success", `${d.sessionsCount} sessions`);
      } else if (d?.chars) {
        line = theme.fg("success", path.basename(d?.sourcePath || "session")) + theme.fg("muted", ` (${d.chars} chars)`);
      }
      if (!expanded) return new Text(line, 0, 0);
      const text = (result.content.find((c: any) => c.type === "text") as any)?.text || "";
      const preview = text.length > 600 ? text.slice(0, 600) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  // ---------------------------------------------------------------------------
  // Unified UI command
  // ---------------------------------------------------------------------------

  async function showMainMenu(ctx: any) {
    if (!ctx.hasUI) {
      pi.sendMessage(
        {
          customType: "session-memory",
          content: "Error: /session-memory requires interactive UI.",
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }

    const choice = await ctx.ui.select("Session memory", [
      "[1] Status",
      "[2] Rebuild index",
      "[3] Search sessions",
      "[4] Find session (search + read top hit)",
      "[5] List sessions",
      "[6] Resume a session",
      "[7] Export session to Markdown",
    ]);

    if (!choice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const idxMatch = choice.match(/^\[(\d+)\]/);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) : -1;

    switch (idx) {
      case 1:
        await runStatus(ctx);
        break;
      case 2:
        await runRebuild(ctx);
        break;
      case 3:
        await runSearch(ctx);
        break;
      case 4:
        await runFind(ctx);
        break;
      case 5:
        await runList(ctx);
        break;
      case 6:
        await runResume(ctx);
        break;
      case 7:
        await runExport(ctx);
        break;
      default:
        ctx.ui.notify("Unknown choice", "error");
    }
  }

  async function runStatus(ctx: any) {
    try {
      const status = await apiStatus();
      const lines = [
        `Session Index: ${status.enabled ? "enabled" : "disabled"}`,
        `Indexed: ${status.indexed_count ?? 0}`,
        `Model: ${status.embedding_model ?? "n/a"}`,
        `Root: ${status.root ?? "n/a"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error: ${msg}`, "error");
    }
  }

  async function runRebuild(ctx: any) {
    try {
      const res = await apiRebuild();
      const lines = [
        "Rebuild OK",
        `Scanned: ${res.scanned ?? 0}`,
        `Indexed: ${res.indexed ?? 0}`,
        `Skipped: ${res.skipped ?? 0}`,
        `Deleted: ${res.deleted ?? 0}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error: ${msg}`, "error");
    }
  }

  async function runSearch(ctx: any) {
    const query = await ctx.ui.input("Search query", "e.g., OAuth2 FastAPI setup");
    if (!query?.trim()) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const scopeChoice = await ctx.ui.select("Choose search scope", [
      "[1] Project tree (cwd + sub-directories)",
      "[2] All projects",
    ]);
    if (!scopeChoice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    let scope: "project" | "all" = "project";
    if (scopeChoice.startsWith("[2]")) scope = "all";

    let result: any;
    try {
      result = await actionSearch(
        { action: "search", query: query.trim(), limit: 8, minScore: 0.3, scope, cwd },
        ctx as any,
        pi,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error searching: ${msg}`, "error");
      return;
    }

    if (result.isError || result.details?.error) {
      const text = (result.content.find((c: any) => c.type === "text") as any)?.text || String(result.details?.error);
      ctx.ui.notify(text, "error");
      return;
    }

    const last = getLastSearch(ctx);
    if (!last || last.hits.length === 0) {
      ctx.ui.notify("No relevant sessions found.", "warning");
      return;
    }

    const options = last.hits.map((h, i) => {
      const project = extractProject(h.source_path);
      const date = h.date ? h.date.replace("T", " ").slice(0, 19) : "unknown";
      const preview = h.text.trim().replace(/\s+/g, " ").slice(0, 80);
      return `[${i}] ${project} · ${date} · ${preview}`;
    });
    options.push("[cancel]");

    const selected = await ctx.ui.select("Select a result to read", options);
    if (!selected || selected === "[cancel]") {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const idxMatch = selected.match(/^\[(\d+)\]/);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) : -1;
    const hit = last.hits[idx];
    if (!hit) {
      ctx.ui.notify("Could not resolve selected result", "error");
      return;
    }

    await readSessionIntoEditor(ctx, hit.source_path);
  }

  async function runFind(ctx: any) {
    const query = await ctx.ui.input("Find session context", "e.g., exact error message from typecheck");
    if (!query?.trim()) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const scopeChoice = await ctx.ui.select("Choose search scope", [
      "[1] Project tree (cwd + sub-directories)",
      "[2] All projects",
    ]);
    if (!scopeChoice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    let scope: "project" | "all" = "project";
    if (scopeChoice.startsWith("[2]")) scope = "all";

    let result: any;
    try {
      result = await actionFind(
        { action: "find", query: query.trim(), limit: 1, minScore: 0.3, scope, cwd },
        ctx as any,
        pi,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error finding session: ${msg}`, "error");
      return;
    }

    if (result.isError || result.details?.error) {
      const text = (result.content.find((c: any) => c.type === "text") as any)?.text || String(result.details?.error);
      ctx.ui.notify(text, "error");
      return;
    }

    if (!result.details?.sourcePath) {
      ctx.ui.notify("No relevant session found.", "warning");
      return;
    }

    await readSessionIntoEditor(ctx, result.details.sourcePath as string);
  }

  async function readSessionIntoEditor(ctx: any, sourcePath: string) {
    let result: Awaited<ReturnType<typeof apiSessionContent>>;
    try {
      result = await apiSessionContent(sourcePath, 30, 4000, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error loading session: ${msg}`, "error");
      return;
    }

    const headerParts = [
      `## Session: ${path.basename(sourcePath)}`,
      `Project: ${result.project || extractProject(sourcePath)}`,
      `Date: ${result.date || "unknown"}`,
      `Messages: ${result.returned_messages}/${result.total_messages}${result.truncated ? " (truncated)" : ""}`,
      `sourcePath: ${sourcePath}`,
      "",
      "---",
      "",
    ];
    ctx.ui.setEditorText(headerParts.join("\n") + result.text);
    ctx.ui.notify("Session loaded into editor. Review and press Enter to send.", "info");
  }

  async function runList(ctx: any) {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const scopeChoice = await ctx.ui.select("Choose session scope", [
      "[1] Project tree (cwd + sub-directories)",
      "[2] All projects",
    ]);
    if (!scopeChoice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    let scope: "project" | "all" = "project";
    if (scopeChoice.startsWith("[2]")) scope = "all";

    let sessions: SessionListItem[];
    try {
      sessions = await apiListSessions(scope, cwd, 50);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error listing sessions: ${msg}`, "error");
      return;
    }

    if (sessions.length === 0) {
      ctx.ui.notify("No saved sessions found.", "warning");
      return;
    }

    const options = sessions.map((s, i) => `[${i}] ${formatSessionOption(s)}`);
    options.push("[cancel]");
    const selected = await ctx.ui.select("Select a session to read", options);
    if (!selected || selected === "[cancel]") {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const idxMatch = selected.match(/^\[(\d+)\]/);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) : -1;
    const sourcePath = sessions[idx]?.source_path;
    if (!sourcePath) {
      ctx.ui.notify("Could not resolve selected session", "error");
      return;
    }

    await readSessionIntoEditor(ctx, sourcePath);
  }

  async function runResume(ctx: any) {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const scopeChoice = await ctx.ui.select("Choose session scope", [
      "[1] Project tree (cwd + sub-directories)",
      "[2] All projects",
    ]);
    if (!scopeChoice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    let scope: "project" | "all" = "project";
    if (scopeChoice.startsWith("[2]")) scope = "all";

    let sessions: SessionListItem[];
    try {
      sessions = await apiListSessions(scope, cwd, 50);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error listing sessions: ${msg}`, "error");
      return;
    }

    if (sessions.length === 0) {
      const scopeLabel = scope === "project" ? "project tree" : "all projects";
      ctx.ui.notify(`No saved sessions found for ${scopeLabel}.`, "warning");
      return;
    }

    const options = sessions.map((s, i) => `[${i}] ${formatSessionOption(s)}`);
    const selected = await ctx.ui.select("Select a session to load", options);
    if (!selected) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const idxMatch = selected.match(/^\[(\d+)\]/);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) : -1;
    const sourcePath = sessions[idx]?.source_path;
    if (!sourcePath) {
      ctx.ui.notify("Could not resolve selected session", "error");
      return;
    }

    const note = await ctx.ui.input("Add a note for the agent (optional)", "e.g., focus on the OAuth setup discussion");

    let result: Awaited<ReturnType<typeof apiSessionContent>>;
    try {
      result = await apiSessionContent(sourcePath, 30, 4000, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error loading session: ${msg}`, "error");
      return;
    }

    const headerParts = [
      `Context from previous session [${result.project || extractProject(sourcePath)}, ${result.date || "unknown"}]`,
      `sourcePath: ${sourcePath}`,
    ];
    if (note?.trim()) headerParts.push(`Note: ${note.trim()}`);
    headerParts.push(`Messages: ${result.returned_messages}/${result.total_messages}${result.truncated ? " (truncated)" : ""}`);
    const fullText = `${headerParts.join("\n")}\n\n---\n\n${result.text}`;
    ctx.ui.setEditorText(fullText);
    ctx.ui.notify("Session context loaded into editor. Review and press Enter to send.", "info");
  }

  async function runExport(ctx: any) {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const groups = groupSessionsByProject(200);
    if (groups.length === 0) {
      ctx.ui.notify("No saved sessions found.", "warning");
      return;
    }

    const sourcePath = await openSessionExportTUI(ctx.ui, groups);
    if (!sourcePath) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const formatChoice = await ctx.ui.select("Export format", [
      "[1] chat — only user/assistant text",
      "[2] outline — user/assistant + short action summary",
      "[3] full — everything including tool calls and results",
    ]);
    if (!formatChoice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    const formatMap: Record<string, ExportFormat> = {
      "[1] chat — only user/assistant text": "chat",
      "[2] outline — user/assistant + short action summary": "outline",
      "[3] full — everything including tool calls and results": "full",
    };
    const format = formatMap[formatChoice];
    if (!format) {
      ctx.ui.notify("Unknown format", "error");
      return;
    }

    const result = exportSessionToMarkdown(sourcePath, format, cwd);
    if (result.ok) {
      ctx.ui.notify(
        `Exported to ${path.basename(result.path)}\n${result.entries} entries, ${result.chars} chars`,
        "info"
      );
    } else {
      ctx.ui.notify(`Export failed: ${(result as { error: string }).error}`, "error");
    }
  }

  pi.registerCommand("session-memory", {
    description: "Open the session memory menu (status, rebuild, search, find, resume, export)",
    handler: async (_args, ctx) => {
      await showMainMenu(ctx);
    },
  });
}
