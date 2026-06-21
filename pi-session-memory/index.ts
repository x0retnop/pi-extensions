import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";

const BASE_URL =
  process.env.PI_SESSION_MEMORY_URL?.trim() ||
  process.env.PI_BACKEND_URL?.trim() ||
  "http://127.0.0.1:8000";
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
}

// ---------------------------------------------------------------------------
// API clients
// ---------------------------------------------------------------------------

async function apiSearch(query: string, limit: number): Promise<SearchHit[]> {
  const res = await fetch(`${BASE_URL}/api/session_index/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.hits || [];
}

async function apiSessionContent(
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

async function apiStatus(): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/session_index/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiRebuild(): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/session_index/rebuild`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiListSessions(
  scope: "current" | "all",
  cwd: string,
  limit = 50,
): Promise<SessionListItem[]> {
  const res = await fetch(`${BASE_URL}/api/session_index/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, cwd, limit }),
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

function extractProject(sourcePath: string): string {
  const parts = sourcePath.split(/[\\/]/);
  for (const part of parts) {
    if (part.startsWith("--") && part.endsWith("--")) {
      const inner = part.slice(2, -2);
      if (inner.includes("--")) {
        const segments = inner.split("--");
        if (segments.length > 0 && /^[A-Za-z]$/.test(segments[0])) {
          segments[0] = segments[0] + ":";
        }
        return segments.join("/");
      }
    }
  }
  return path.basename(path.dirname(sourcePath));
}

function formatHitPreview(hit: SearchHit, maxLen: number): string {
  let text = hit.text.trim();
  if (text.length > maxLen) text = text.slice(0, maxLen) + "\n...[truncated]";
  return `[Project: ${extractProject(hit.source_path)}] [Date: ${hit.date || "unknown"}] [Score: ${hit.score.toFixed(3)}]\n${text}`;
}

function formatSessionOption(s: SessionListItem): string {
  const project = s.project || extractProject(s.source_path);
  const date = s.date ? s.date.replace("T", " ").slice(0, 19) : "unknown";
  const name = path.basename(s.source_path);
  return `${date}  |  ${project}  |  ${name}`;
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
  onUpdate?.({
    content: [{ type: "text", text: `Searching sessions: "${params.query}"...` }],
    details: { phase: "search" },
  });

  let hits: SearchHit[];
  try {
    hits = await apiSearch(params.query, params.limit ?? 3);
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
    const last = getLastSearch(ctx);
    if (!last) {
      return {
        content: [
          { type: "text", text: "Error: No recent session_memory search found. Run action=search first or provide sourcePath." },
        ],
        details: { error: "No recent search" },
        isError: true,
      };
    }
    const hit = last.hits[params.hitIndex];
    if (!hit) {
      return {
        content: [
          { type: "text", text: `Error: hitIndex ${params.hitIndex} out of range (0-${last.hits.length - 1})` },
        ],
        details: { error: "Index out of range" },
        isError: true,
      };
    }
    sourcePath = hit.source_path;
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

async function actionList(params: any, _ctx: ExtensionContext): Promise<any> {
  const cwd = params.cwd || _ctx.cwd || _ctx.sessionManager.getCwd();
  const scope = params.scope ?? "current";
  try {
    const sessions = await apiListSessions(scope, cwd, params.limit ?? 50);
    if (sessions.length === 0) {
      return {
        content: [{ type: "text", text: "No saved sessions found." }],
        details: { sessionsCount: 0 },
      };
    }
    let output = `Saved sessions (${scope === "current" ? "current project" : "all projects"}):\n\n`;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      output += `[${i}] ${formatSessionOption(s)}\n  sourcePath: ${s.source_path}\n\n`;
    }
    output += `Use session_memory(action="content", sourcePath=...) or /session-memory to load one.`;
    return {
      content: [{ type: "text", text: output }],
      details: { sessionsCount: sessions.length },
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
]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_memory",
    label: "Session Memory",
    description:
      "Unified access to the user's past conversation history. Search for relevant sessions, list saved sessions, or read a specific session safely.",
    promptSnippet:
      "Use when the user asks about something from a previous conversation. action=search returns preview hits; action=content reads one session; action=list enumerates recent sessions.",
    promptGuidelines: [
      "TRIGGERS — call this tool when the user uses phrases like: 'recall', 'remember', 'where did we', 'how did I before', 'as we discussed earlier', 'in a previous session', 'как я делал раньше', 'в прошлый раз', 'где мы обсуждали', 'напомни', 'найди в истории'.",
      "WORKFLOW — start with action=search. Then use action=content with hitIndex from the search result if the user wants details. Never guess from training data.",
      "QUERY QUALITY — for action=search use specific technical terms, file names, error messages, or framework names. Avoid vague single words.",
      "LISTING — use action=list when the user asks to see recent sessions without a specific query. Scope can be 'current' or 'all'.",
      "SCORE INTERPRETATION — score is cosine similarity [-1, 1]. Higher is better. Values > 0.5 are usually strongly relevant. Compare relative magnitudes within the result set.",
      "LIMITS — action=content uses safe defaults (maxMessages=30, maxChars=4000, toolResultLimit=1000). Increase only if the user explicitly asks for more.",
      "NEVER use the raw read tool on .jsonl session files — they can be 50 MB+. Always use session_memory.",
    ],
    parameters: Type.Object({
      action: SessionMemoryActionSchema,
      query: Type.Optional(
        Type.String({
          description: "Required for action=search. Be specific — use technical terms, file names, or problem descriptions.",
        }),
      ),
      sourcePath: Type.Optional(
        Type.String({
          description: "Required for action=content unless hitIndex is provided. Absolute path to the .jsonl session file.",
        }),
      ),
      hitIndex: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Index from the last session_memory search result (0 = top hit).",
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("all")], {
          default: "current",
          description: "For action=list: show sessions for current project or all projects.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "For action=list: override current working directory. Usually leave empty.",
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
          return actionList(params, ctx);
        default:
          return {
            content: [{ type: "text", text: `Error: unknown action "${params.action}". Use search, content, or list.` }],
            details: { error: "Unknown action" },
            isError: true,
          };
      }
    },

    renderCall(args, theme) {
      const a = args as any;
      const action = a.action || "?";
      let detail = "";
      if (action === "search") detail = a.query || "";
      else if (action === "content") detail = a.sourcePath ? path.basename(a.sourcePath) : `hitIndex=${a.hitIndex ?? "?"}`;
      else if (action === "list") detail = a.scope || "current";
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
      "[4] Resume a session",
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
        await runResume(ctx);
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
    try {
      const result = await actionSearch({ action: "search", query: query.trim(), limit: 5, minScore: 0.3 }, ctx as any, pi);
      const text = (result.content.find((c: any) => c.type === "text") as any)?.text || "";
      ctx.ui.notify(text.length > 800 ? text.slice(0, 800) + "\n...[truncated]" : text, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error searching: ${msg}`, "error");
    }
  }

  async function runResume(ctx: any) {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const scopeChoice = await ctx.ui.select("Choose session scope", [
      "[1] Current project",
      "[2] All projects",
    ]);
    if (!scopeChoice) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    const scope = scopeChoice.startsWith("[2]") ? "all" : "current";

    let sessions: SessionListItem[];
    try {
      sessions = await apiListSessions(scope, cwd, 50);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Error listing sessions: ${msg}`, "error");
      return;
    }

    if (sessions.length === 0) {
      ctx.ui.notify(`No saved sessions found for ${scope === "current" ? "current directory" : "all projects"}.`, "warning");
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

  pi.registerCommand("session-memory", {
    description: "Open the session memory menu (status, rebuild, search, resume)",
    handler: async (_args, ctx) => {
      await showMainMenu(ctx);
    },
  });
}
