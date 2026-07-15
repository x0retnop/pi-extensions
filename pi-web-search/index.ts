import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { setStatusBlock } from "../common/status.js";

// ---------------------------------------------------------------------------
// TUI helpers for compact, width-safe tool rendering.
// Use pi-tui's Text component: it wraps/truncates by terminal cell width
// (CJK/emoji safe, ANSI aware). Hand-rolled char-count truncation overflows
// the box width on wide glyphs and corrupts the diff renderer.
// ---------------------------------------------------------------------------

function textComponent(text: string): Text {
  return new Text(text, 0, 0);
}

function formatUrl(url: string, maxLen = 60): string {
  return truncateToWidth(url, maxLen);
}

function formatQuery(q: string, maxLen = 50): string {
  return truncateToWidth(q, maxLen);
}

const WEB_TOOLS = ["web_search", "fetch_content", "code_search"] as const;
const WEB_ACCESS_STATE_TYPE = "web-access-state";
const PROVIDER_NAMES = ["exa", "brave", "ollama_cloud", "ddg"] as const;
const PROVIDER_DESCRIPTION =
  "Preferred provider: 'exa', 'brave', 'ollama_cloud', 'ddg'. Backend falls back to its configured chain.";

// Allow runtime injection of a different base URL for tests.
let BASE_URL = process.env.PI_WEB_SEARCH_URL?.trim()
  || process.env.PI_BACKEND_URL?.trim()
  || "http://127.0.0.1:8000";

export function setBaseUrl(url: string): void { BASE_URL = url; }
const MCP_PATH = process.env.PI_WEB_SEARCH_MCP_PATH?.trim() || "/mcp";

interface WebAccessState {
  enabled: boolean;
}

interface BackendStatus {
  enabled: boolean;
  mcp_enabled: boolean;
  mcp_path: string;
  mcp_transport: string;
  provider_chain: string[];
  default_provider: string | null;
  summarizer_mode: string;
  max_results: number;
  fetch_max_chars: number;
  providers: Record<string, boolean>;
}

export async function getBackendStatus(signal?: AbortSignal): Promise<BackendStatus | null> {
  try {
    const base = BASE_URL.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/web_research/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      enabled: Boolean(data.enabled),
      mcp_enabled: Boolean(data.mcp_enabled),
      mcp_path: typeof data.mcp_path === "string" ? data.mcp_path : "/mcp",
      mcp_transport: typeof data.mcp_transport === "string" ? data.mcp_transport : "streamable-http",
      provider_chain: Array.isArray(data.provider_chain) ? data.provider_chain.map((x) => String(x)) : [],
      default_provider: data.default_provider == null ? null : String(data.default_provider),
      summarizer_mode: typeof data.summarizer_mode === "string" ? data.summarizer_mode : "none",
      max_results: typeof data.max_results === "number" ? data.max_results : 10,
      fetch_max_chars: typeof data.fetch_max_chars === "number" ? data.fetch_max_chars : 32000,
      providers: data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)
        ? Object.fromEntries(Object.entries(data.providers as Record<string, unknown>).map(([k, v]) => [k, Boolean(v)]))
        : {},
    };
  } catch {
    return null;
  }
}

function formatProviderInfo(status: BackendStatus | null): string {
  if (!status) return "";
  const chain = status.provider_chain.length ? status.provider_chain.join(", ") : "unknown";
  const defaultProvider = status.default_provider ?? "unknown";
  return `Default provider: ${defaultProvider} (chain: ${chain}).`;
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc?: string;
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { result?: string };
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

export function getMcpUrl(): string {
  const base = BASE_URL.replace(/\/+$/, "");
  const path = MCP_PATH.startsWith("/") ? MCP_PATH : `/${MCP_PATH}`;
  return `${base}${path}`;
}

function getLatestWebAccessState(ctx: ExtensionContext): WebAccessState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === WEB_ACCESS_STATE_TYPE) {
      return entry.data as WebAccessState;
    }
  }
  return null;
}

function syncWebAccessTools(pi: ExtensionAPI, enabled: boolean): void {
  const current = pi.getActiveTools();
  const base = current.filter((name) => !WEB_TOOLS.some((tool) => tool === name));
  const next = enabled ? [...base, ...WEB_TOOLS] : base;
  pi.setActiveTools([...new Set(next)]);
}

function setWebAccessStatus(ctx: ExtensionContext, enabled: boolean): void {
  setStatusBlock(ctx, "web-access", enabled ? "web:on" : undefined);
}

function normalizeQueryList(queryList: unknown[]): string[] {
  const normalized: string[] = [];
  for (const query of queryList) {
    if (typeof query !== "string") continue;
    const trimmed = query.trim();
    if (trimmed.length > 0) normalized.push(trimmed);
  }
  return normalized;
}

function parseMCPResponse(raw: string, requestId?: number): MCPResponse | null {
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as MCPResponse;
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
        return parsed;
      }
    } catch {
      // Not a plain JSON response; fall through to SSE parsing.
    }
  }

  const candidates: MCPResponse[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as MCPResponse;
      if (parsed && typeof parsed === "object") candidates.push(parsed);
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;
  if (requestId !== undefined) {
    const matched = candidates.find((c) => c.id === requestId);
    if (matched) return matched;
  }
  return candidates.find((c) => c.result !== undefined || c.error !== undefined) ?? candidates[0];
}

export async function mcpCall(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<MCPResponse> {
  const url = getMcpUrl();
  const id = Date.now();
  const body: MCPRequest = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const raw = await res.text();
  const parsed = parseMCPResponse(raw, id);
  if (!parsed) {
    throw new Error("Invalid MCP response from backend");
  }
  if (parsed.error) {
    throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed;
}

async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; details: Record<string, unknown> }> {
  const response = await mcpCall("tools/call", { name, arguments: args }, signal);
  const result = response.result;
  if (!result) {
    throw new Error("Empty tool result from backend");
  }

  const textItem = result.content?.find((c) => c.type === "text" && typeof c.text === "string");
  const text = textItem?.text ?? result.structuredContent?.result ?? "";

  let details: Record<string, unknown> = {};
  let content = text;
  try {
    const parsed = JSON.parse(text) as { content?: string; details?: Record<string, unknown>; error?: string };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string") {
        return { content: `Error: ${parsed.error}`, details: { error: parsed.error } };
      }
      if (typeof parsed.content === "string") content = parsed.content;
      if (parsed.details && typeof parsed.details === "object") details = parsed.details;
    }
  } catch {
    // backend returned plain markdown; use raw text as content
  }

  return { content, details };
}

function backendUnavailableResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const isConnectionError = msg.includes("ECONNREFUSED")
    || msg.includes("fetch failed")
    || msg.includes("Unable to connect")
    || msg.includes("Failed to fetch");

  const text = isConnectionError
    ? `Web search backend is not available at ${getMcpUrl()}. Ensure the 0x010 runtime is running and MCP is enabled.`
    : `Web search backend error: ${msg}`;

  return {
    content: [{ type: "text" as const, text }],
    details: { error: text, backendUrl: getMcpUrl() },
  };
}

export default function (pi: ExtensionAPI) {
  function handleSessionChange(ctx: ExtensionContext): void {
    const state = getLatestWebAccessState(ctx);
    const enabled = state?.enabled ?? false;
    syncWebAccessTools(pi, enabled);
    setWebAccessStatus(ctx, enabled);
  }

  pi.on("session_start", (_event, ctx) => handleSessionChange(ctx));
  pi.on("session_tree", (_event, ctx) => handleSessionChange(ctx));

  pi.registerCommand("web", {
    description: "Toggle web search tools on/off",
    handler: async (args, ctx) => {
      const state = getLatestWebAccessState(ctx);
      const currentlyEnabled = state?.enabled ?? false;
      let enabled: boolean;
      const arg = args.trim().toLowerCase();
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else enabled = !currentlyEnabled;

      pi.appendEntry(WEB_ACCESS_STATE_TYPE, { enabled });
      syncWebAccessTools(pi, enabled);
      setWebAccessStatus(ctx, enabled);
      ctx.ui.notify(`Web access ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("web-status", {
    description: "Check web search backend status, default provider, and configuration",
    handler: async (_args, ctx) => {
      try {
        const [status] = await Promise.all([
          getBackendStatus(),
          mcpCall("tools/list", {}),
        ]);
        const providerLine = formatProviderInfo(status);
        ctx.ui.notify(
          `Web search backend is reachable at ${getMcpUrl()}. ${providerLine}`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Web search backend unreachable: ${msg}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "General-purpose web search. Use it when you need current facts, URLs, official docs, news, or discussion threads that are not in your training context. " +
      "Returns a markdown list of sources (title, URL, snippet) plus a backend-LLM summary unless 'raw' is set.",
    promptSnippet:
      "Use for current events, docs, URLs, or facts outside your training data. One call = one research round.",
    promptGuidelines: [
      "Use for current facts, URLs, official docs, news, or discussions outside your training context.",
      "Prefer the two-step workflow: web_search to discover sources, then fetch_content on the best URLs for detailed reading.",
      "For broad or multi-angle topics, pass 'queries' with 2-4 varied phrasings instead of a single 'query' — they run in parallel and merge with URL dedup.",
      "Result count: 'depth' presets apply when 'num_results' is not set ('quick' = 5, 'standard' = 10, 'deep' = 15). Set 'num_results' explicitly for any other count; it overrides 'depth'.",
      "Use 'recency_filter' for time-sensitive topics: 'day' or 'week' for news, 'month' or 'year' for broader context.",
      "Use 'domain_filter' to include or exclude domains, e.g. ['docs.python.org'] or ['-medium.com'].",
      "Use 'answer_mode' when you want a direct answer synthesized by the backend LLM on top of the source list.",
      "Use 'summarize' for a bullet overview. Use 'include_content' only when you need full page text inline; it is slow, token-heavy, and only exa supports it (the backend auto-prefers exa when set).",
      "Set 'raw' to skip the backend LLM summary when you will read and synthesize sources yourself — faster and cheaper.",
      "The footer line shows which provider served the results and whether fallback was used; if results are poor, retry with a different 'provider'.",
      "Do not use for programming examples or API docs — use code_search for those.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Single search query. Prefer 'queries' for multi-angle research.",
      })),
      queries: Type.Optional(Type.Array(Type.String(), {
        description: "2-4 related queries with varied phrasing/scope. Preferred for research; they run in parallel.",
      })),
      num_results: Type.Optional(Type.Number({
        description: "Max results. Overrides the 'depth' preset; omit to use the depth default.",
      })),
      include_content: Type.Optional(Type.Boolean({
        description: "Fetch full page content inline (exa only; the backend auto-prefers exa when set). Slower and token-heavy.",
      })),
      depth: Type.Optional(StringEnum(["quick", "standard", "deep"], {
        description: "Preset result count used when 'num_results' is not set: 'quick' = 5, 'standard' = 10, 'deep' = 15.",
      })),
      recency_filter: Type.Optional(StringEnum(["day", "week", "month", "year"], {
        description: "Limit results by recency.",
      })),
      domain_filter: Type.Optional(Type.Array(Type.String(), {
        description: "Include domains like ['docs.python.org'] or exclude with ['-medium.com'].",
      })),
      summarize: Type.Optional(Type.Boolean({
        description: "Return bullet summary from backend LLM on top of the result list.",
      })),
      answer_mode: Type.Optional(Type.Boolean({
        description: "Return direct answer synthesized by backend LLM from results.",
      })),
      raw: Type.Optional(Type.Boolean({
        description: "Skip the backend LLM summary/answer entirely — faster, cheaper, raw sources only.",
      })),
      provider: Type.Optional(StringEnum(PROVIDER_NAMES, {
        description: PROVIDER_DESCRIPTION,
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const rawQueryList: unknown[] = Array.isArray(params.queries)
        ? params.queries
        : (params.query !== undefined ? [params.query] : []);
      const queryList = normalizeQueryList(rawQueryList);

      if (queryList.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
          details: { error: "No query provided" },
        };
      }

      const q = queryList.join(" ");
      onUpdate?.({
        content: [{ type: "text" as const, text: `Searching: "${q}"...` }],
        details: { phase: "search", currentQuery: q },
      });

      try {
        // Forward only explicitly set values: the backend derives the result
        // count from 'depth' when 'num_results' is absent, and an explicit
        // num_results overrides the depth preset there.
        const { content, details } = await callTool("web_search", {
          queries: queryList,
          num_results: params.num_results,
          include_content: params.include_content ?? false,
          depth: params.depth,
          recency_filter: params.recency_filter,
          domain_filter: params.domain_filter,
          summarize: params.summarize ?? false,
          answer_mode: params.answer_mode ?? false,
          raw: params.raw ?? false,
          provider: params.provider,
        }, signal);

        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        return backendUnavailableResult(err);
      }
    },

    renderCall(args, theme) {
      const input = args as {
        query?: unknown;
        queries?: unknown;
        depth?: string;
        num_results?: number;
        recency_filter?: string;
        domain_filter?: string[];
        summarize?: boolean;
        answer_mode?: boolean;
        raw?: boolean;
        provider?: string;
        include_content?: boolean;
      };
      const rawQueryList: unknown[] = Array.isArray(input.queries)
        ? input.queries
        : (input.query !== undefined ? [input.query] : []);
      const queryList = normalizeQueryList(rawQueryList);

      if (queryList.length === 0) {
        return textComponent(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"));
      }

      const badges: string[] = [];
      if (input.depth && input.depth !== "standard") badges.push(input.depth);
      if (input.num_results != null && input.num_results !== 10) badges.push(`${input.num_results}`);
      if (input.recency_filter) badges.push(input.recency_filter);
      if (input.summarize) badges.push("summarize");
      if (input.answer_mode) badges.push("answer");
      if (input.raw) badges.push("raw");
      if (input.include_content) badges.push("full");
      if (input.provider) badges.push(input.provider);
      if (input.domain_filter && input.domain_filter.length > 0) {
        badges.push(input.domain_filter.length === 1 ? input.domain_filter[0] : `${input.domain_filter.length} domains`);
      }

      const lines: string[] = [];
      // Show the full query text (wrapped to terminal width by Text), capped
      // only against pathological length — the request must stay readable.
      let label = theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${formatQuery(queryList[0], 300)}"`);
      if (badges.length > 0) {
        label += theme.fg("dim", ` • ${badges.join(" · ")}`);
      }
      lines.push(label);
      for (const q of queryList.slice(1)) {
        lines.push(theme.fg("dim", "+ ") + theme.fg("accent", `"${formatQuery(q, 300)}"`));
      }
      return textComponent(lines.join("\n"));
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return textComponent("");
      }
      const details = result.details as {
        error?: string;
        query?: string;
        queries?: string[] | null;
        provider_used?: string;
        result_count?: number;
        fallback_used?: boolean;
        summarizer_error?: string;
        answer?: string;
        llm_tokens_used?: { total_tokens?: number | null } | null;
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      } | undefined;

      if (details?.error) {
        return textComponent(theme.fg("error", `Error: ${details.error}`));
      }

      const count = details?.result_count ?? 0;
      const provider = details?.provider_used ?? "unknown";
      const totalTokens = details?.llm_tokens_used?.total_tokens;

      const badges: string[] = [];
      if (details?.fallback_used) badges.push("fallback");
      if (totalTokens != null) badges.push(`${totalTokens} tokens`);
      if (details?.summarizer_error) badges.push("summary error");

      let line = theme.fg("success", `${count} sources`) + theme.fg("muted", ` via ${provider}`);
      if (badges.length > 0) {
        line += theme.fg("dim", ` • ${badges.join(" · ")}`);
      }

      const lines: string[] = [line];

      const queries = Array.isArray(details?.queries) ? details.queries : (details?.query ? [details.query] : []);
      if (queries.length > 0) {
        lines.push(theme.fg("toolTitle", "Queries:"));
        for (const q of queries.slice(0, 5)) {
          lines.push(`  ${theme.fg("accent", `"${q}"`)}`);
        }
        if (queries.length > 5) {
          lines.push(theme.fg("dim", `  ...and ${queries.length - 5} more queries`));
        }
      }

      if (details?.answer) {
        lines.push("");
        const preview = truncateToWidth(details.answer, expanded ? 600 : 280);
        lines.push(theme.fg("accent", "Answer: ") + theme.fg("dim", preview));
      }

      const results = details?.results ?? [];
      if (results.length > 0) {
        lines.push("");
        lines.push(theme.fg("toolTitle", "Results:"));
        const maxItems = expanded ? 20 : 12;
        for (let i = 0; i < Math.min(results.length, maxItems); i++) {
          const r = results[i];
          const title = formatQuery(r.title || "Untitled", 46);
          const url = formatUrl(r.url || "", 58);
          const num = theme.fg("toolTitle", `${i + 1}.`);
          lines.push(`  ${num} ${theme.fg("accent", title)} ${theme.fg("muted", "—")} ${theme.fg("dim", url)}`);
          if (expanded && r.snippet) {
            lines.push(`      ${theme.fg("dim", truncateToWidth(r.snippet, 140))}`);
          }
        }

        if (results.length > maxItems) {
          lines.push(theme.fg("dim", `  ...and ${results.length - maxItems} more`));
        }
      }

      return textComponent(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch the readable markdown content of one or more known URLs. Best for reading docs, articles, or GitHub pages found by web_search or provided by the user. " +
      "Default max_chars is 32000; use save_full to persist truncated full text to %TEMP%.",
    promptSnippet:
      "Use when you already have a URL and need its full text. Prefer one URL per call for complete content.",
    promptGuidelines: [
      "Use when the user provides a URL, or when web_search found a URL that needs detailed reading.",
      "Prefer one URL per call for the full article. Multi-URL calls concatenate full pages.",
      "Do not set 'max_chars' below 1000; omit it to use the default (32000). Use higher values only when you need more content.",
      "GitHub /blob/ URLs are automatically fetched as raw files.",
      "Use 'save_full' when you expect truncation and need the complete markdown written to %TEMP%.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({
        description: "Single URL to fetch.",
      })),
      urls: Type.Optional(Type.Array(Type.String(), {
        description: "Multiple URLs to fetch in parallel.",
      })),
      max_chars: Type.Optional(Type.Number({
        minimum: 1000,
        description: "Per-page character cap (default: 32000, minimum: 1000).",
      })),
      save_full: Type.Optional(Type.Boolean({
        description: "Save full fetched markdown to %TEMP% if truncated.",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const urlList = params.urls ?? (params.url ? [params.url] : []);
      if (urlList.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: No URL provided." }],
          details: { error: "No URL provided" },
        };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: `Fetching ${urlList.length} URL(s)...` }],
        details: { phase: "fetch", urlCount: urlList.length },
      });

      try {
        const maxChars = Math.max(params.max_chars ?? 32000, 1000);
        const { content, details } = await callTool("fetch_content", {
          urls: urlList,
          max_chars: maxChars,
          save_full: params.save_full ?? false,
        }, signal);

        // When a page was truncated and saved, the backend already appends
        // the file path and a correct file:/// curl command to the content.
        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        return backendUnavailableResult(err);
      }
    },

    renderCall(args, theme) {
      const input = args as { url?: string; urls?: string[]; max_chars?: number; save_full?: boolean };
      const urlList = input.urls ?? (input.url ? [input.url] : []);
      if (urlList.length === 0) {
        return textComponent(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"));
      }

      const badges: string[] = [];
      if (input.max_chars != null && input.max_chars !== 32000) badges.push(`${input.max_chars} chars`);
      if (input.save_full) badges.push("save_full");

      const lines: string[] = [];
      // Show the full URL (wrapped to terminal width by Text).
      let label = theme.fg("toolTitle", theme.bold("fetch "))
        + theme.fg("accent", urlList.length === 1 ? formatUrl(urlList[0], 300) : `${urlList.length} URLs`);
      if (badges.length > 0) {
        label += theme.fg("dim", ` • ${badges.join(" · ")}`);
      }
      lines.push(label);
      if (urlList.length > 1) {
        for (const u of urlList.slice(0, 5)) {
          lines.push(theme.fg("dim", "+ ") + theme.fg("accent", formatUrl(u, 300)));
        }
        if (urlList.length > 5) {
          lines.push(theme.fg("dim", `+ ${urlList.length - 5} more URLs`));
        }
      }
      return textComponent(lines.join("\n"));
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return textComponent("");
      }
      const details = result.details as {
        error?: string;
        urls?: string[];
        max_chars?: number;
        save_full?: boolean;
        full_content_paths?: (string | null)[];
        results?: Array<{ url: string; title?: string; status_code?: number; chars_returned?: number; truncated?: boolean }>;
      } | undefined;
      if (details?.error) {
        return textComponent(theme.fg("error", `Error: ${details.error}`));
      }
      const results = details?.results ?? [];
      const count = results.length || details?.urls?.length || 1;
      const limit = details?.max_chars ?? 32000;
      const truncatedCount = results.filter((r) => r.truncated).length;
      const failedCount = results.filter((r) => r.status_code != null && r.status_code >= 400).length;

      let line = theme.fg("success", `${count} URL(s) fetched`) + theme.fg("muted", ` • limit ${limit} chars`);
      if (truncatedCount > 0) {
        line += theme.fg("warning", ` • ${truncatedCount} truncated`);
      }
      if (failedCount > 0) {
        line += theme.fg("error", ` • ${failedCount} failed`);
      }
      if (details?.save_full) {
        line += theme.fg("accent", " • save_full");
      }
      if (!expanded) return textComponent(line);

      const lines: string[] = [line];
      for (const r of results) {
        const title = formatQuery(r.title || "Untitled", 40);
        const url = formatUrl(r.url, 50);
        const status = r.status_code != null && r.status_code >= 400
          ? theme.fg("error", `${r.status_code}`)
          : theme.fg("muted", `${r.status_code ?? "ok"}`);
        const chars = theme.fg("muted", `${r.chars_returned ?? "?"} chars`);
        const truncated = r.truncated ? theme.fg("warning", " truncated") : "";
        lines.push(`${status} ${theme.fg("accent", title)} ${theme.fg("muted", "—")} ${theme.fg("dim", url)} ${chars}${truncated}`);
      }

      const savedPaths = (details?.full_content_paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
      if (savedPaths.length > 0) {
        lines.push(theme.fg("accent", "Saved full content:"));
        for (const p of savedPaths) lines.push(theme.fg("dim", `  ${p}`));
      }

      return textComponent(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description:
      "Code-biased search for programming questions, API usage, code snippets, repositories, and documentation. The backend rewrites the query to target GitHub and documentation domains.",
    promptSnippet:
      "Use for code: API usage, library examples, implementations, debugging. Not for news or general facts.",
    promptGuidelines: [
      "Use for code: API methods, error messages, library usage, examples, or repository locations.",
      "Backend targets GitHub and documentation domains; do not add 'site:' unless you need a specific domain.",
      "Use 'focus' to steer targeting: 'docs' = official documentation, 'repos' = GitHub/GitLab projects, 'code' = mixed. Default 'auto' infers it from the query.",
      "If no provider is specified, the backend prefers exa for code search, then brave, ollama_cloud, and ddg.",
      "Use 'max_tokens' to control output length (default: 5000). Higher values preserve more docs and snippets.",
      "The footer line shows which provider served the request and whether fallback was used; retry with 'provider' if results are poor.",
      "If results are poor, fall back to web_search with a broader query.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Programming question or topic.",
      }),
      num_results: Type.Optional(Type.Number({
        description: "Max results (default: 10).",
      })),
      max_tokens: Type.Optional(Type.Integer({
        minimum: 1000,
        maximum: 50000,
        description: "Approximate output budget in tokens (default: 5000).",
      })),
      focus: Type.Optional(StringEnum(["auto", "code", "docs", "repos"], {
        description: "Domain targeting: 'docs' = official documentation, 'repos' = GitHub/GitLab projects, 'code' = mixed, 'auto' = infer from the query (default).",
      })),
      raw: Type.Optional(Type.Boolean({
        description: "Skip the backend LLM summary/answer entirely — faster, cheaper, raw sources only.",
      })),
      provider: Type.Optional(StringEnum(PROVIDER_NAMES, {
        description: PROVIDER_DESCRIPTION,
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      if (!params.query?.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: No query provided." }],
          details: { error: "No query provided" },
        };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: `Code search: "${params.query}"...` }],
        details: { phase: "search", currentQuery: params.query },
      });

      try {
        const { content, details } = await callTool("code_search", {
          query: params.query.trim(),
          num_results: params.num_results ?? 10,
          max_tokens: params.max_tokens ?? 5000,
          provider: params.provider,
          focus: params.focus,
          raw: params.raw ?? false,
        }, signal);

        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        return backendUnavailableResult(err);
      }
    },

    renderCall(args, theme) {
      const input = args as { query?: string; num_results?: number; max_tokens?: number; focus?: string; raw?: boolean; provider?: string };
      const display = !input.query ? "(no query)" : `"${formatQuery(input.query, 300)}"`;
      const badges: string[] = [];
      if (input.num_results != null && input.num_results !== 10) badges.push(`${input.num_results}`);
      if (input.max_tokens != null && input.max_tokens !== 5000) badges.push(`${input.max_tokens} tokens`);
      if (input.focus && input.focus !== "auto") badges.push(input.focus);
      if (input.raw) badges.push("raw");
      if (input.provider) badges.push(input.provider);

      let label = theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("accent", display);
      if (badges.length > 0) {
        label += theme.fg("dim", ` • ${badges.join(" · ")}`);
      }
      return textComponent(label);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return textComponent("");
      }
      const details = result.details as {
        error?: string;
        query?: string;
        provider_used?: string;
        result_count?: number;
        fallback_used?: boolean;
        answer?: string;
        llm_tokens_used?: { total_tokens?: number | null } | null;
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      } | undefined;
      if (details?.error) {
        return textComponent(theme.fg("error", `Error: ${details.error}`));
      }
      const count = details?.result_count ?? 0;
      const provider = details?.provider_used ?? "unknown";
      const totalTokens = details?.llm_tokens_used?.total_tokens;

      const badges: string[] = [];
      if (details?.fallback_used) badges.push("fallback");
      if (totalTokens != null) badges.push(`${totalTokens} tokens`);

      let line = theme.fg("success", `${count} sources`) + theme.fg("muted", ` via ${provider}`);
      if (badges.length > 0) {
        line += theme.fg("dim", ` • ${badges.join(" · ")}`);
      }

      const lines: string[] = [line];

      if (details?.query) {
        lines.push(theme.fg("toolTitle", "Query: ") + theme.fg("accent", `"${details.query}"`));
      }

      if (details?.answer) {
        lines.push("");
        const preview = truncateToWidth(details.answer, expanded ? 600 : 280);
        lines.push(theme.fg("accent", "Answer: ") + theme.fg("dim", preview));
      }

      const results = details?.results ?? [];
      if (results.length > 0) {
        lines.push("");
        lines.push(theme.fg("toolTitle", "Results:"));
        const maxItems = expanded ? 20 : 12;
        for (let i = 0; i < Math.min(results.length, maxItems); i++) {
          const r = results[i];
          const title = formatQuery(r.title || "Untitled", 46);
          const url = formatUrl(r.url || "", 58);
          const num = theme.fg("toolTitle", `${i + 1}.`);
          lines.push(`  ${num} ${theme.fg("accent", title)} ${theme.fg("muted", "—")} ${theme.fg("dim", url)}`);
          if (expanded && r.snippet) {
            lines.push(`      ${theme.fg("dim", truncateToWidth(r.snippet, 140))}`);
          }
        }

        if (results.length > maxItems) {
          lines.push(theme.fg("dim", `  ...and ${results.length - maxItems} more`));
        }
      }

      return textComponent(lines.join("\n"));
    },
  });
}
