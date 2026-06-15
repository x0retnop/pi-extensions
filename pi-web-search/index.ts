import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

const WEB_TOOLS = ["web_search", "fetch_content", "code_search"] as const;
const GATE_TOOL = "web_access";
const WEB_ACCESS_STATE_TYPE = "web-access-state";
const PROVIDER_NAMES = ["exa", "brave", "ollama_cloud", "ddg"] as const;
const PROVIDER_DESCRIPTION =
  "Preferred provider: 'exa', 'brave', 'ollama_cloud', 'ddg'. Backend falls back to its configured chain.";

const BASE_URL = process.env.PI_WEB_SEARCH_URL?.trim()
  || process.env.PI_BACKEND_URL?.trim()
  || "http://127.0.0.1:8000";
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

async function getBackendStatus(signal?: AbortSignal): Promise<BackendStatus | null> {
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
      fetch_max_chars: typeof data.fetch_max_chars === "number" ? data.fetch_max_chars : 16000,
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

function getMcpUrl(): string {
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
  const base = current.filter((name) => name !== GATE_TOOL && !WEB_TOOLS.some((tool) => tool === name));
  const next = enabled ? [...base, ...WEB_TOOLS] : [...base, GATE_TOOL];
  pi.setActiveTools([...new Set(next)]);
}

function setWebAccessStatus(ctx: ExtensionContext, enabled: boolean): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus("web-access", enabled ? "web: on" : undefined);
  }
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

async function mcpCall(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<MCPResponse> {
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
    name: GATE_TOOL,
    label: "Web Access",
    description:
      "Check and toggle web access. When web search is disabled, this tool is the only web tool available; " +
      "call it to see the current status, the default provider, and the command to enable web tools.",
    promptSnippet:
      "If the user asks for web content and web tools are disabled, call web_access first.",
    promptGuidelines: [
      "When web tools are disabled and the user asks for web search, URLs, or code examples, call web_access.",
      "web_access returns the current status, default provider, and instructions. Pass that information to the user.",
      "To enable web tools, tell the user to run /web (or /web on).",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const state = getLatestWebAccessState(ctx);
      const currentlyEnabled = state?.enabled ?? false;
      const status = await getBackendStatus(signal);
      const providerLine = formatProviderInfo(status);

      if (currentlyEnabled) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Web access is already enabled. " +
                `${providerLine} Use web_search, code_search, or fetch_content directly.`,
            },
          ],
          details: { enabled: true, backend_status: status },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Web access is currently disabled. " +
              `${providerLine} Tell the user to run /web to enable web search, fetch, and code search tools.`,
          },
        ],
        details: { enabled: false, backend_status: status },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("web_access ")) + theme.fg("warning", "disabled"), 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { enabled?: boolean } | undefined;
      if (details?.enabled) {
        return new Text(theme.fg("success", "Web access already enabled"), 0, 0);
      }
      return new Text(theme.fg("warning", "Web access disabled — remind user to run /web"), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "General-purpose web search. Use it when you need current facts, URLs, official docs, news, or discussion threads that are not in your training context. Returns a markdown answer plus a list of sources with URLs.",
    promptSnippet:
      "Use for current events, docs, URLs, or facts outside your training data. One call = one research round.",
    promptGuidelines: [
      "Use for current facts, URLs, official docs, news, or discussions outside your training context.",
      "Prefer the two-step workflow: web_search to discover sources, then fetch_content on the best URLs for detailed reading.",
      "For broad or multi-angle topics, pass 'queries' with 2-4 varied phrasings instead of a single 'query'.",
      "Use 'depth' to choose result count: 'quick' = 5, 'standard' = 10, 'deep' = 15. 'num_results' overrides this if set.",
      "Use 'recency_filter' for time-sensitive topics: 'day' or 'week' for news, 'month' or 'year' for broader context.",
      "Use 'domain_filter' to include or exclude domains, e.g. ['docs.python.org'] or ['-medium.com'].",
      "Use 'answer_mode' when you want the backend to synthesize a direct answer from results (you lose the raw source list).",
      "Use 'summarize' for a bullet overview. Use 'include_content' only when you need full page text inline; it is slow and token-heavy.",
      "Do not use for programming examples or API docs — use code_search for those.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Single search query. Prefer 'queries' for multi-angle research.",
      })),
      queries: Type.Optional(Type.Array(Type.String(), {
        description: "2-4 related queries with varied phrasing/scope. Preferred for research.",
      })),
      num_results: Type.Optional(Type.Number({
        description: "Max results (default: 10). Overrides 'depth' if both are set.",
      })),
      include_content: Type.Optional(Type.Boolean({
        description: "Fetch full page content inline. Slower and token-heavy.",
      })),
      depth: Type.Optional(StringEnum(["quick", "standard", "deep"], {
        description: "Preset result count: 'quick' = 5, 'standard' = 10, 'deep' = 15.",
      })),
      recency_filter: Type.Optional(StringEnum(["day", "week", "month", "year"], {
        description: "Limit results by recency.",
      })),
      domain_filter: Type.Optional(Type.Array(Type.String(), {
        description: "Include domains like ['docs.python.org'] or exclude with ['-medium.com'].",
      })),
      summarize: Type.Optional(Type.Boolean({
        description: "Return bullet summary from backend LLM instead of raw result list.",
      })),
      answer_mode: Type.Optional(Type.Boolean({
        description: "Return direct answer synthesized by backend LLM from results.",
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
        const { content, details } = await callTool("web_search", {
          queries: queryList,
          num_results: params.num_results ?? 10,
          include_content: params.include_content ?? false,
          depth: params.depth ?? "standard",
          recency_filter: params.recency_filter,
          domain_filter: params.domain_filter,
          summarize: params.summarize ?? false,
          answer_mode: params.answer_mode ?? false,
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
      const input = args as { query?: unknown; queries?: unknown };
      const rawQueryList: unknown[] = Array.isArray(input.queries)
        ? input.queries
        : (input.query !== undefined ? [input.query] : []);
      const queryList = normalizeQueryList(rawQueryList);
      if (queryList.length === 0) {
        return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
      }
      if (queryList.length === 1) {
        const q = queryList[0];
        const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
        return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
      }
      return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        error?: string;
        provider_used?: string;
        result_count?: number;
        fallback_used?: boolean;
        summarizer_error?: string;
      } | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      const count = details?.result_count ?? 0;
      const provider = details?.provider_used ?? "unknown";
      let line = theme.fg("success", `${count} sources`) + theme.fg("muted", ` • ${provider}${details?.fallback_used ? " (fallback)" : ""}`);
      if (details?.summarizer_error) {
        line += theme.fg("warning", ` • summary error: ${details.summarizer_error}`);
      }
      if (!expanded) return new Text(line, 0, 0);
      const text = result.content.find((c) => c.type === "text")?.text || "";
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch the readable markdown content of one or more known URLs. Best for reading docs, articles, or GitHub pages found by web_search or provided by the user.",
    promptSnippet:
      "Use when you already have a URL and need its full text. Prefer one URL per call for complete content.",
    promptGuidelines: [
      "Use when the user provides a URL, or when web_search found a URL that needs detailed reading.",
      "Prefer one URL per call for the full article. Multi-URL calls concatenate full pages.",
      "Set 'max_chars' to cap output per page (default: 16000).",
      "GitHub /blob/ URLs are automatically fetched as raw files.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({
        description: "Single URL to fetch.",
      })),
      urls: Type.Optional(Type.Array(Type.String(), {
        description: "Multiple URLs to fetch in parallel.",
      })),
      max_chars: Type.Optional(Type.Number({
        description: "Per-page character cap (default: 16000).",
      })),
      force_clone: Type.Optional(Type.Boolean({
        description: "Reserved for future use.",
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
        const { content, details } = await callTool("fetch_content", {
          urls: urlList,
          max_chars: params.max_chars ?? 16000,
          force_clone: params.force_clone ?? false,
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
      const input = args as { url?: string; urls?: string[] };
      const urlList = input.urls ?? (input.url ? [input.url] : []);
      if (urlList.length === 0) {
        return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
      }
      if (urlList.length === 1) {
        const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
        return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display), 0, 0);
      }
      return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        error?: string;
        urls?: string[];
        max_chars?: number;
        results?: Array<{ url: string; title?: string; chars_returned?: number; truncated?: boolean }>;
      } | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      const results = details?.results ?? [];
      const count = results.length || details?.urls?.length || 1;
      const limit = details?.max_chars ?? 16000;
      const truncatedCount = results.filter((r) => r.truncated).length;
      let line = theme.fg("success", `${count} URL(s) fetched`) + theme.fg("muted", ` • limit ${limit} chars`);
      if (truncatedCount > 0) {
        line += theme.fg("warning", ` • ${truncatedCount} truncated`);
      }
      if (!expanded) return new Text(line, 0, 0);
      const text = result.content.find((c) => c.type === "text")?.text || "";
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
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
      "If no provider is specified, the backend prefers exa for code search, then brave, ollama_cloud, and ddg.",
      "Use 'max_tokens' to control output length (default: 5000). Higher values preserve more docs and snippets.",
      "Check 'details.providers_tried' and 'details.provider_used' to see which provider actually served the request.",
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
      const input = args as { query?: string };
      const display = !input.query
        ? "(no query)"
        : input.query.length > 70 ? input.query.slice(0, 67) + "..." : input.query;
      return new Text(theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("accent", display), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { error?: string; provider_used?: string; result_count?: number; fallback_used?: boolean } | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      const count = details?.result_count ?? 0;
      const provider = details?.provider_used ?? "unknown";
      const line = theme.fg("success", `${count} sources`) + theme.fg("muted", ` • ${provider}${details?.fallback_used ? " (fallback)" : ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const text = result.content.find((c) => c.type === "text")?.text || "";
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });
}
