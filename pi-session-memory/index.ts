import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";

const BASE_URL = "http://127.0.0.1:8000";
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

async function apiSessionContent(sourcePath: string, maxMessages: number, maxChars: number): Promise<{ source_path: string; project: string; date: string; text: string; total_messages: number; returned_messages: number; chars: number; truncated: boolean }> {
  const res = await fetch(`${BASE_URL}/api/session_index/session_content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_path: sourcePath, max_messages: maxMessages, max_chars: maxChars }),
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

interface SessionListItem {
  source_path: string;
  project: string;
  date: string;
}

async function apiListSessions(scope: "current" | "all", cwd: string, limit = 50): Promise<SessionListItem[]> {
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
  if (sourcePath.includes("--C--")) {
    const match = sourcePath.split("--C--")[1]?.split("--")[0];
    return match || "unknown";
  }
  return path.basename(path.dirname(sourcePath));
}

function formatHitPreview(hit: SearchHit, maxLen: number): string {
  let text = hit.text.trim();
  if (text.length > maxLen) text = text.slice(0, maxLen) + "\n...[truncated]";
  return `[Project: ${extractProject(hit.source_path)}] [Date: ${hit.date || "unknown"}] [Score: ${hit.score.toFixed(3)}]\n${text}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_sessions",
    label: "Search Sessions",
    description:
      "Search the user's past conversation history for previously discussed solutions, configurations, code patterns, or decisions. Returns short preview excerpts only — always follow up with get_session_content to read the full session.",
    promptSnippet:
      "Use when the user asks about something from a previous conversation, wants to recall how a problem was solved, or refers to past work. One call returns preview hits. Always follow up with get_session_content(hitIndex) if the user wants details.",
    promptGuidelines: [
      "TRIGGERS — call this tool when the user uses phrases like: 'recall', 'remember', 'where did we', 'how did I before', 'as we discussed earlier', 'in a previous session', 'как я делал раньше', 'в прошлый раз', 'где мы обсуждали', 'напомни', 'найди в истории'.",
      "TOPIC INDICATORS — also trigger when the user refers to: a past project, a config from before, a previous fix, earlier setup steps, old decisions, or anything that happened in prior conversations.",
      "WORKFLOW — always follow search_sessions with get_session_content(hitIndex=0) if the user wants details. Never guess from training data; the truth is in the indexed sessions.",
      "QUERY QUALITY — the query parameter should use specific technical terms, file names, error messages, or framework names. Avoid vague single words. Example: 'NextAuth credentials provider setup' is better than 'auth'.",
      "SCORE INTERPRETATION — score is cosine similarity [-1, 1]. Higher is better. Values > 0.5 are usually strongly relevant. Compare relative magnitudes within the result set.",
      "NEVER use the raw read tool on .jsonl session files — they can be 50 MB+. Always use get_session_content.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to search for. Be specific — use technical terms, file names, or problem descriptions." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 3, description: "Max preview hits (1-5)." })),
      minScore: Type.Optional(Type.Number({ minimum: -1, maximum: 1, default: 0.3, description: "Minimum relevance score. Values > 0.5 are usually strongly relevant." })),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Searching sessions: "${params.query}"...` }],
        details: { phase: "search" },
      });

      let hits: SearchHit[];
      try {
        hits = await apiSearch(params.query, params.limit ?? 3);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
          return {
            content: [{ type: "text", text: "Error: 0x010 server is not running on 127.0.0.1:8000. Start uvicorn and ensure SESSION_INDEX_ENABLED=true." }],
            details: { error: "Server unreachable", raw: msg },
          };
        }
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: { error: msg },
        };
      }

      const minScore = params.minScore ?? 0.3;
      const filtered = hits.filter((h) => h.score >= minScore);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: "No relevant sessions found. Try a different query or lower minScore." }],
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

      output += `Use get_session_content({ hitIndex: N }) to read a specific session with safe limits.`;

      return {
        content: [{ type: "text", text: output }],
        details: { hitsCount: filtered.length, topScore: filtered[0]?.score, queries: [params.query] },
      };
    },

    renderCall(args, theme) {
      const q = (args as any).query || "";
      const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
      return new Text(theme.fg("toolTitle", theme.bold("session_search ")) + theme.fg("accent", `"${display}"`), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) {
        return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      }
      const line = d?.hitsCount === 0
        ? theme.fg("muted", "0 hits")
        : theme.fg("success", `${d?.hitsCount ?? 0} hits`) + theme.fg("muted", ` • top score ${(d?.topScore ?? 0).toFixed(3)}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = (result.content.find((c: any) => c.type === "text") as any)?.text || "";
      const preview = text.length > 600 ? text.slice(0, 600) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  pi.registerTool({
    name: "get_session_content",
    label: "Get Session Content",
    description:
      "Read a specific past conversation session safely, with hard size limits. Use only as the second step after search_sessions (via hitIndex) or when the user provides an exact session path.",
    promptSnippet:
      "Second step after search_sessions. Pass hitIndex from the last search result, or sourcePath if explicitly given. Hard limits prevent context overflow.",
    promptGuidelines: [
      "ALWAYS call this after search_sessions, using hitIndex from that result. Only use sourcePath if the user explicitly provides a full .jsonl path.",
      "Default limits (maxMessages=30, maxChars=4000) are safe. Increase only if the user explicitly asks for more content.",
      "Never use this tool as a first step — search_sessions must run first to identify which session is relevant.",
    ],
    parameters: Type.Object({
      sourcePath: Type.Optional(Type.String({ description: "Absolute path to the .jsonl file. Prefer hitIndex when following up on a search." })),
      hitIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Index from the last search_sessions result (0 = top hit)." })),
      maxMessages: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30, description: "Latest messages to include." })),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 12000, default: 4000, description: "Hard output character limit." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let sourcePath: string | undefined = params.sourcePath;

      if (!sourcePath && params.hitIndex !== undefined) {
        const last = getLastSearch(ctx);
        if (!last) {
          return {
            content: [{ type: "text", text: "Error: No recent search_sessions found. Run search_sessions first or provide sourcePath." }],
            details: { error: "No recent search" },
          };
        }
        const hit = last.hits[params.hitIndex];
        if (!hit) {
          return {
            content: [{ type: "text", text: `Error: hitIndex ${params.hitIndex} out of range (0-${last.hits.length - 1})` }],
            details: { error: "Index out of range" },
          };
        }
        sourcePath = hit.source_path;
      }

      if (!sourcePath) {
        return {
          content: [{ type: "text", text: "Error: Provide sourcePath or hitIndex." }],
          details: { error: "No source specified" },
        };
      }

      let result: { source_path: string; project: string; date: string; text: string; total_messages: number; returned_messages: number; chars: number; truncated: boolean };
      try {
        result = await apiSessionContent(sourcePath, params.maxMessages ?? 30, params.maxChars ?? 4000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error reading session: ${msg}` }],
          details: { error: msg, sourcePath },
        };
      }

      const header = `## Session: ${path.basename(sourcePath)}\nProject: ${extractProject(sourcePath)}\nMessages: ${result.returned_messages}/${result.total_messages}${result.truncated ? " (truncated)" : ""}\n\n`;
      return {
        content: [{ type: "text", text: header + result.text }],
        details: { sourcePath, project: extractProject(sourcePath), chars: result.chars, truncated: result.truncated },
      };
    },

    renderCall(args, theme) {
      const a = args as any;
      let label = "";
      if (a.sourcePath) {
        label = path.basename(a.sourcePath);
      } else if (a.hitIndex !== undefined) {
        label = `hitIndex=${a.hitIndex}`;
      } else {
        label = "(no source)";
      }
      return new Text(theme.fg("toolTitle", theme.bold("session_content ")) + theme.fg("accent", label), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as any;
      if (d?.error) {
        return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      }
      const line = theme.fg("success", path.basename(d?.sourcePath || "session")) + theme.fg("muted", ` (${d?.chars ?? 0} chars)`);
      if (!expanded) return new Text(line, 0, 0);
      const text = (result.content.find((c: any) => c.type === "text") as any)?.text || "";
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  pi.registerCommand("session-memory-status", {
    description: "Show session vector index status",
    handler: async (_args, ctx) => {
      try {
        const status = await apiStatus();
        const msg = `Session Index: ${status.enabled ? "enabled" : "disabled"}\nIndexed: ${status.indexed_count}\nModel: ${status.embedding_model}\nRoot: ${status.root}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "session-memory-status", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const out = `Error: ${msg}`;
        if (ctx.hasUI) ctx.ui.notify(out, "error");
        else pi.sendMessage({ customType: "session-memory-status", content: out, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("session-memory-rebuild", {
    description: "Trigger incremental rebuild of session index",
    handler: async (_args, ctx) => {
      try {
        const res = await apiRebuild();
        const msg = `Rebuild OK\nScanned: ${res.scanned}\nIndexed: ${res.indexed}\nSkipped: ${res.skipped}\nDeleted: ${res.deleted}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else pi.sendMessage({ customType: "session-memory-rebuild", content: msg, display: true }, { triggerTurn: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const out = `Error: ${msg}`;
        if (ctx.hasUI) ctx.ui.notify(out, "error");
        else pi.sendMessage({ customType: "session-memory-rebuild", content: out, display: true }, { triggerTurn: false });
      }
    },
  });

  pi.registerCommand("session-memory-resume", {
    description: "Load context from a saved session into the editor (default: current dir; use 'all' for all projects)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        const out = "Error: session-memory-resume requires interactive UI";
        pi.sendMessage({ customType: "session-memory-resume", content: out, display: true }, { triggerTurn: false });
        return;
      }
      const scope = args?.trim().toLowerCase() === "all" ? "all" : "current";
      const cwd = ctx.cwd || ctx.sessionManager.getCwd();
      let sessions: SessionListItem[];
      try {
        sessions = await apiListSessions(scope, cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Error listing sessions: ${msg}`, "error");
        return;
      }
      if (sessions.length === 0) {
        ctx.ui.notify(`No saved sessions found for ${scope === "current" ? "current directory" : "all projects"}.`, "warning");
        return;
      }
      const options = sessions.map((s, i) => `[${i}] [${s.date}] ${s.project}`);
      const selected = await ctx.ui.select("Select a session to load context from", options);
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
      let result: { source_path: string; project: string; date: string; text: string; total_messages: number; returned_messages: number; chars: number; truncated: boolean };
      try {
        result = await apiSessionContent(sourcePath, 30, 4000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Error loading session: ${msg}`, "error");
        return;
      }
      const headerParts = [`Context from previous session [${result.project}, ${result.date}]`];
      if (note?.trim()) headerParts.push(`Note: ${note.trim()}`);
      headerParts.push(`Messages: ${result.returned_messages}/${result.total_messages}${result.truncated ? " (truncated)" : ""}`);
      const fullText = `${headerParts.join("\n")}\n\n---\n\n${result.text}`;
      ctx.ui.setEditorText(fullText);
      ctx.ui.notify("Session context loaded into editor. Review and press Enter to send.", "info");
    },
  });
}
