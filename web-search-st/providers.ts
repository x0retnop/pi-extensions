// Provider layer: Exa MCP (via curl.exe — Cloudflare blocks Node TLS),
// Bing HTML, Tavily, Brave. Ordered chain with fallback, quality-first default.
import { headerValue, runCurl } from "./curl.js";
import { type ProviderName, normalizeChain, normalizeDisabled } from "./settings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  numResults: number;
  /** "day" | "week" | "month" | "year" — supported by tavily/brave only. */
  recencyFilter?: string;
  /** Include domains as-is; exclude with "-domain". Brave/Bing use `site:`
   *  (multiple includes are OR). Tavily uses include/exclude arrays. Exa ignores it. */
  domainFilter?: string[];
  /** "exa" | "bing" | "tavily" | "brave" | "auto" — empty means auto chain. */
  preferredProvider?: string;
  /** Whether to fall through the chain on error/empty. Default true. */
  allowFallback?: boolean;
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  sourceProvider: string;
}

export interface ProviderAttempt {
  query: string;
  provider: string;
  status: "ok" | "empty" | "error" | "skipped";
  detail?: string;
  count?: number;
}

export interface ProviderOutcome {
  results: SearchResult[];
  providerUsed: string | null;
  providersUsed: string[];
  fallbackUsed: boolean;
  errors: string[];
  attempts: ProviderAttempt[];
}

export interface FetchOptions {
  maxChars: number;
  signal?: AbortSignal;
}

export interface FetchResult {
  url: string;
  title: string;
  content: string;
  sourceProvider: string;
  statusCode?: number;
  truncated: boolean;
  fullContentPath: string | null;
  /** Failed/ok hops, e.g. ["jina HTTP 403", "exa ok"]. */
  attempts?: string[];
}

export interface SearchProvider {
  readonly name: string;
  isAvailable(): boolean;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

async function nodeFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const TRACKING_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "spm", "mc_cid", "mc_eid", "fbclid", "gclid"]);

/** Canonical URL for dedup: lowercase host, drop www./fragments/tracking,
 *  sort query params, strip trailing slash. */
export function canonicalUrl(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const port = u.port ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const query = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_KEYS.has(k.toLowerCase()))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const proto = (u.protocol || "https:").toLowerCase();
    return `${proto}//${host}${port}${path}${query ? `?${query}` : ""}`;
  } catch {
    return raw;
  }
}

export function dedupResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    const key = canonicalUrl(r.url);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(r);
  }
  return unique;
}

/** Round-robin across per-query lists so a later phrasing is not buried. */
export function interleaveResults(groups: SearchResult[][]): SearchResult[] {
  const out: SearchResult[] = [];
  let i = 0;
  let more = true;
  while (more) {
    more = false;
    for (const g of groups) {
      if (i < g.length) {
        out.push(g[i]);
        more = true;
      }
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exa MCP (via curl.exe)
// ---------------------------------------------------------------------------

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_PROTOCOL = "2025-06-18";

interface MCPPayload { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { code: number; message: string } }

function parseSSE(text: string): MCPPayload[] {
  const out: MCPPayload[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload) as MCPPayload);
    } catch { /* skip malformed */ }
  }
  return out;
}

function exaCurlHeaders(sessionId?: string): string[] {
  const headers = [
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json, text/event-stream",
    "-H", `User-Agent: ${UA}`,
    "-H", `MCP-Protocol-Version: ${EXA_PROTOCOL}`,
  ];
  if (sessionId) headers.push("-H", `Mcp-Session-Id: ${sessionId}`);
  return headers;
}

function mcpText(payload: MCPPayload | undefined): string {
  if (!payload) throw new Error("Exa MCP returned no SSE messages");
  if (payload.error) throw new Error(`Exa MCP error ${payload.error.code}: ${payload.error.message}`);
  return (payload.result?.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("\n\n");
}

async function exaMcpToolsCall(
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  const initBody = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: EXA_PROTOCOL, capabilities: {}, clientInfo: { name: "pi-web-search-st", version: "0.1.0" } },
  });
  const init = await runCurl(EXA_MCP_URL, {
    timeoutMs: Math.min(opts.timeoutMs, 15000),
    signal: opts.signal,
    body: initBody,
    extraArgs: exaCurlHeaders(),
  });
  if (init.status >= 400) throw new Error(`Exa MCP init HTTP ${init.status}`);
  const sid = headerValue(init.headers, "mcp-session-id");
  if (!sid) throw new Error("Exa MCP init returned no session id");

  const callBody = JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name, arguments: args },
  });
  const call = await runCurl(EXA_MCP_URL, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    body: callBody,
    extraArgs: exaCurlHeaders(sid),
  });
  if (call.status >= 400) throw new Error(`Exa MCP call HTTP ${call.status}`);
  return mcpText(parseSSE(call.body)[0]);
}

/** Drop Exa placeholders (`N/A`, `-`) so the tool output does not echo them. */
export function cleanPublishedDate(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (!v || /^n\/a$/i.test(v) || v === "-" || v === "null") return undefined;
  return v;
}

/** Parse Exa MCP search text (Title/URL/Published/Author/Highlights blocks). */
export function parseExaSearchText(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of text.split("\n\n")) {
    const e = entry.trim();
    if (!e) continue;
    let title = "";
    let url = "";
    let published: string | undefined;
    let inHighlights = false;
    const snippetLines: string[] = [];
    for (const rawLine of e.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("Title:")) title = line.slice(6).trim();
      else if (line.startsWith("URL:")) url = line.slice(4).trim();
      else if (line.startsWith("Published:")) published = cleanPublishedDate(line.slice(10));
      else if (line.startsWith("Highlights:")) inHighlights = true;
      else if (inHighlights && line) snippetLines.push(line.replace(/^-\s*/, ""));
    }
    if (!url) continue;
    results.push({
      title: title || url,
      url,
      snippet: sanitizeSnippet(snippetLines.join(" ") || e),
      publishedDate: published,
      sourceProvider: "exa",
    });
  }
  return results;
}

export class ExaProvider implements SearchProvider {
  readonly name = "exa";
  private timeoutMs: number;
  constructor(timeoutMs = 20000) { this.timeoutMs = timeoutMs; }
  isAvailable(): boolean { return true; }
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Exa MCP takes only query+numResults; recency/domain filters unsupported.
    const text = await exaMcpToolsCall("web_search_exa", {
      query: query.trim(),
      numResults: Math.max(1, Math.min(options.numResults, 20)),
    }, { timeoutMs: this.timeoutMs, signal: options.signal });
    return parseExaSearchText(text);
  }
}

// ---------------------------------------------------------------------------
// Exa fetch (web_fetch_exa) — same curl-based MCP client, different tool
// ---------------------------------------------------------------------------

export async function exaFetchUrl(
  urls: string[],
  maxChars: number,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<Array<{ url: string; content: string; title: string }>> {
  const combined = await exaMcpToolsCall("web_fetch_exa", {
    urls,
    maxCharacters: Math.max(1, maxChars),
  }, opts);
  if (!combined.trim()) return [];
  // Exa returns one block per URL, each starting "# Title\nURL: ...". Split
  // on that boundary — "# " headers inside a single page are not boundaries.
  const blocks = splitExaFetchBlocks(combined);
  const out: Array<{ url: string; content: string; title: string }> = [];
  for (let i = 0; i < blocks.length && i < urls.length; i++) {
    const block = blocks[i];
    const titleMatch = block.match(/^#\s+(.+)$/m) || block.match(/^Title:\s*(.+)$/m);
    out.push({
      url: urls[i],
      title: titleMatch ? titleMatch[1].trim().slice(0, 200) : "Untitled",
      content: block,
    });
  }
  return out;
}

function looksLikeExaErrorBody(s: string): boolean {
  return /^Error fetching URL/i.test(s) || /^CRAWL_HTTP_\d+/.test(s);
}

/** Exa sometimes returns a crawl error as the page body (HTTP 200). */
export function isExaFetchError(content: string): boolean {
  const t = (content || "").trim();
  if (!t) return false;
  if (looksLikeExaErrorBody(t)) return true;
  // Framed "# Title\nURL: …\n\nError fetching URL…" — not a mention in a real page.
  const body = t.replace(/^#\s[^\n]+\nURL:\s[^\n]+\n+/, "").trim();
  return body !== t && looksLikeExaErrorBody(body);
}

export function splitExaFetchBlocks(text: string): string[] {
  // Each result block starts with "# Title\nURL: ...". Split on newline
  // boundaries before such lines. Using only "\n" as the separator (never
  // "^") guarantees non-zero match length, so lastIndex always advances.
  const parts: string[] = [];
  const re = /\n(?=#\s[^\n]+\nURL:\s*https?:\/\/)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + 1;
    if (start > last) parts.push(text.slice(last, start).trim());
    last = start;
  }
  if (last < text.length) parts.push(text.slice(last).trim());
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Bing HTML (via node fetch — no Cloudflare on bing.com)
// ---------------------------------------------------------------------------

const BING_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export function decodeBingUrl(href: string): string {
  // Bing wraps result URLs in /ck/a?...&u=a1<base64url>. Decode the u param.
  try {
    const u = new URL(href.replaceAll("&amp;", "&"));
    const enc = u.searchParams.get("u") ?? "";
    if (enc.startsWith("a1")) {
      const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      return Buffer.from(padded, "base64").toString("utf-8");
    }
    return href;
  } catch {
    return href;
  }
}

export class BingProvider implements SearchProvider {
  readonly name = "bing";
  private timeoutMs: number;
  constructor(timeoutMs = 15000) { this.timeoutMs = timeoutMs; }
  isAvailable(): boolean { return true; }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const q = new URL("https://www.bing.com/search");
    q.searchParams.set("q", query.trim());
    q.searchParams.set("mkt", "en-US");
    q.searchParams.set("setlang", "en-US");
    q.searchParams.set("count", String(Math.min(options.numResults, 20)));
    const domainFilter = options.domainFilter ?? [];
    const sites = domainFilterToQuerySuffix(domainFilter);
    if (sites) q.searchParams.set("q", `${query.trim()} ${sites}`);
    const res = await nodeFetch(q.toString(), {
      headers: { "User-Agent": BING_UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: options.signal,
    }, this.timeoutMs);
    if (res.status >= 400) throw new Error(`Bing HTTP ${res.status}`);
    const html = await res.text();
    const results: SearchResult[] = [];
    const algoRe = /<li class="b_algo".*?<\/li>/gs;
    let m: RegExpExecArray | null;
    while ((m = algoRe.exec(html)) !== null && results.length < options.numResults) {
      const block = m[0];
      const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s) || block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
      if (!titleMatch) continue;
      const href = titleMatch[1].replaceAll("&amp;", "&");
      const title = stripTags(titleMatch[2]).trim();
      const url = decodeBingUrl(href);
      const snippetMatch = block.match(/<p[^>]*>(.*?)<\/p>/s);
      const snippet = snippetMatch ? sanitizeSnippet(snippetMatch[1]) : "";
      results.push({ title: title || url, url, snippet, sourceProvider: "bing" });
    }
    return results;
  }
}

const SNIPPET_MAX = 1000;

/** Strip tags, decode entities, collapse whitespace. Used for titles and snippets. */
export function decodeHtml(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeSnippet(s: string, max = SNIPPET_MAX): string {
  const t = decodeHtml(s);
  return t.length <= max ? t : t.slice(0, max);
}

function stripTags(s: string): string {
  return decodeHtml(s);
}

// ---------------------------------------------------------------------------
// Tavily (node fetch, key from env)
// ---------------------------------------------------------------------------

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  private apiKey: string;
  private timeoutMs: number;
  constructor(apiKey: string, timeoutMs = 15000) { this.apiKey = apiKey; this.timeoutMs = timeoutMs; }
  isAvailable(): boolean { return this.apiKey.length > 0; }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query: query.trim(),
      max_results: Math.min(options.numResults, 20),
      search_depth: "basic",
      include_answer: false,
    };
    const domainFilter = options.domainFilter ?? [];
    const include = domainFilter.filter((d) => !d.startsWith("-"));
    const exclude = domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
    if (include.length) body.include_domains = include;
    if (exclude.length) body.exclude_domains = exclude;
    const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    if (options.recencyFilter && days[options.recencyFilter]) body.days = days[options.recencyFilter];

    const res = await nodeFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    }, this.timeoutMs);
    if (res.status === 429) throw new Error("Tavily rate limited (429)");
    if (res.status >= 400) throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return (data.results ?? []).map((r) => ({
      title: r.title || r.url || "Untitled",
      url: r.url || "",
      snippet: sanitizeSnippet(r.content ?? ""),
      publishedDate: r.published_date,
      sourceProvider: "tavily",
    })).filter((r) => r.url);
  }
}

// ---------------------------------------------------------------------------
// Brave (node fetch, key from env)
// ---------------------------------------------------------------------------

export class BraveProvider implements SearchProvider {
  readonly name = "brave";
  private apiKey: string;
  private timeoutMs: number;
  constructor(apiKey: string, timeoutMs = 15000) { this.apiKey = apiKey; this.timeoutMs = timeoutMs; }
  isAvailable(): boolean { return this.apiKey.length > 0; }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const q = new URL("https://api.search.brave.com/res/v1/web/search");
    let qs = query.trim();
    const domainFilter = options.domainFilter ?? [];
    const sites = domainFilterToQuerySuffix(domainFilter);
    if (sites) qs += ` ${sites}`;
    q.searchParams.set("q", qs);
    q.searchParams.set("count", String(Math.min(options.numResults, 20)));
    q.searchParams.set("extra_snippets", "true");
    q.searchParams.set("safesearch", "moderate");
    const freshness: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
    if (options.recencyFilter && freshness[options.recencyFilter]) q.searchParams.set("freshness", freshness[options.recencyFilter]);

    const res = await nodeFetch(q.toString(), {
      headers: { "X-Subscription-Token": this.apiKey, "Accept": "application/json" },
      signal: options.signal,
    }, this.timeoutMs);
    if (res.status === 429) throw new Error("Brave rate limited (429)");
    if (res.status >= 400) throw new Error(`Brave HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; extra_snippets?: string[] }> };
    };
    return (data.web?.results ?? []).map((r) => {
      const extras = Array.isArray(r.extra_snippets) ? r.extra_snippets.join(" ") : "";
      return {
        title: decodeHtml(r.title || r.url || "Untitled"),
        url: r.url || "",
        snippet: sanitizeSnippet([r.description ?? "", extras].filter(Boolean).join(" ")),
        publishedDate: r.age,
        sourceProvider: "brave",
      };
    }).filter((r) => r.url);
  }
}

// ---------------------------------------------------------------------------
// Provider chain
// ---------------------------------------------------------------------------

export interface ProviderChainConfig {
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
  chain?: string[];
  disabled?: string[];
}

export function defaultProviderChain(cfg: ProviderChainConfig = {}): SearchProvider[] {
  const order = normalizeChain(cfg.chain);
  const disabled = new Set(normalizeDisabled(cfg.disabled));
  const make: Record<ProviderName, () => SearchProvider> = {
    exa: () => new ExaProvider(),
    brave: () => new BraveProvider(cfg.BRAVE_API_KEY?.trim() ?? ""),
    tavily: () => new TavilyProvider(cfg.TAVILY_API_KEY?.trim() ?? ""),
    bing: () => new BingProvider(),
  };
  const out: SearchProvider[] = [];
  for (const name of order) {
    if (disabled.has(name)) continue;
    out.push(make[name]());
  }
  return out;
}

export function classifySearchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate limited/i.test(msg)) return "429";
  if (/timeout|aborted|ETIMEDOUT|AbortError/i.test(msg)) return "timeout";
  const http = msg.match(/HTTP (\d{3})/i);
  if (http) return `HTTP ${http[1]}`;
  return msg.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function fallbackReason(attempts: ProviderAttempt[]): string {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const a of attempts) {
    if (a.status !== "empty" && a.status !== "error") continue;
    const label = a.status === "empty" ? `${a.provider} empty` : `${a.provider} ${a.detail || "error"}`;
    if (seen.has(label)) continue;
    seen.add(label);
    reasons.push(label);
  }
  return reasons.slice(0, 3).join(", ");
}

/** Numbered source list for the agent. Empty results keep the footer only. */
export function formatSearchMarkdown(results: SearchResult[], footer: string): string {
  if (results.length === 0) {
    return `No results found.\n\n${footer}`;
  }
  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const published = r.publishedDate ? ` (${r.publishedDate})` : "";
    lines.push(`${i + 1}. **${r.title}**${published}`);
    lines.push(`   - URL: ${r.url}`);
    if (r.snippet) lines.push(`   - ${r.snippet}`);
  }
  lines.push("");
  lines.push(`_${footer}_`);
  return lines.join("\n");
}

/** Brave/Bing `site:` suffix. Multiple includes are OR, not AND. */
export function domainFilterToQuerySuffix(domainFilter: string[]): string {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of domainFilter) {
    const d = raw.trim();
    if (!d) continue;
    if (d.startsWith("-")) {
      const host = d.slice(1).trim();
      if (host) exclude.push(host);
    } else {
      include.push(d);
    }
  }
  const parts: string[] = [];
  if (include.length === 1) parts.push(`site:${include[0]}`);
  else if (include.length > 1) parts.push(`(${include.map((d) => `site:${d}`).join(" OR ")})`);
  for (const d of exclude) parts.push(`-site:${d}`);
  return parts.join(" ");
}

/** Exa ignores recency/domain. When those filters are set, put providers
 *  that honor them first (relative order kept inside each group). */
export function reorderProvidersForFilters(
  providers: SearchProvider[],
  options: SearchOptions,
): SearchProvider[] {
  const recency = Boolean(options.recencyFilter);
  const domain = Boolean(options.domainFilter && options.domainFilter.length > 0);
  if (!recency && !domain) return providers;
  const honors = (name: string): boolean => {
    const recencyOk = !recency || name === "brave" || name === "tavily";
    const domainOk = !domain || name === "brave" || name === "tavily" || name === "bing";
    return recencyOk && domainOk;
  };
  return [
    ...providers.filter((p) => honors(p.name)),
    ...providers.filter((p) => !honors(p.name)),
  ];
}

/** One-line provenance for the agent footer and TUI. */
export function formatSearchFooter(outcome: ProviderOutcome): string {
  if (outcome.results.length === 0) {
    if (outcome.errors.length > 0) return outcome.errors.join(" · ");
    const why = fallbackReason(outcome.attempts);
    return why || "all providers empty";
  }
  const via = outcome.providersUsed.join("+") || outcome.providerUsed || "unknown";
  const bits = [`via ${via}`, `${outcome.results.length} results`];
  if (outcome.fallbackUsed) {
    const why = fallbackReason(outcome.attempts);
    bits.push(why ? `fallback: ${why}` : "fallback");
  }
  return bits.join(" · ");
}

export async function searchWithChain(
  queries: string[],
  options: SearchOptions,
  providers: SearchProvider[],
): Promise<ProviderOutcome> {
  const preferred = options.preferredProvider?.trim().toLowerCase();
  const forced = Boolean(preferred && preferred !== "auto");
  let ordered = forced
    ? [providers.find((p) => p.name === preferred), ...providers.filter((p) => p.name !== preferred)].filter((p): p is SearchProvider => Boolean(p))
    : [...providers];
  if (!forced) ordered = reorderProvidersForFilters(ordered, options);

  const emptyOutcome = (errors: string[], attempts: ProviderAttempt[] = []): ProviderOutcome => ({
    results: [],
    providerUsed: null,
    providersUsed: [],
    fallbackUsed: false,
    errors,
    attempts,
  });

  if (ordered.length === 0) return emptyOutcome(["no available providers"]);

  const rateLimited = new Set<string>();

  const perQuery = await Promise.all(queries.map(async (query) => {
    const results: SearchResult[] = [];
    const errors: string[] = [];
    const attempts: ProviderAttempt[] = [];
    let providerUsed: string | null = null;
    let fallbackUsed = false;
    let queryServed = false;
    let sawAvailable = false;

    for (const provider of ordered) {
      if (options.signal?.aborted) break;
      if (!provider.isAvailable()) {
        attempts.push({ query, provider: provider.name, status: "skipped", detail: "no key" });
        continue;
      }
      if (rateLimited.has(provider.name)) {
        attempts.push({ query, provider: provider.name, status: "skipped", detail: "429" });
        fallbackUsed = true;
        continue;
      }
      const isPrimary = !sawAvailable;
      sawAvailable = true;
      try {
        const r = await provider.search(query, options);
        if (r.length > 0) {
          results.push(...r);
          queryServed = true;
          providerUsed = provider.name;
          if (!isPrimary) fallbackUsed = true;
          attempts.push({ query, provider: provider.name, status: "ok", count: r.length });
          break;
        }
        fallbackUsed = true;
        attempts.push({ query, provider: provider.name, status: "empty" });
        if (options.allowFallback === false) break;
      } catch (err) {
        const detail = classifySearchError(err);
        errors.push(`${provider.name}: ${detail}`);
        fallbackUsed = true;
        attempts.push({ query, provider: provider.name, status: "error", detail });
        if (detail === "429") rateLimited.add(provider.name);
        if (options.allowFallback === false) break;
      }
    }
    if (!queryServed && errors.length === 0) {
      errors.push(sawAvailable ? "all providers returned empty" : "no available providers");
    }
    return { results, errors, attempts, providerUsed, fallbackUsed };
  }));

  const errors: string[] = [];
  const attempts: ProviderAttempt[] = [];
  const providersUsed: string[] = [];
  let providerUsed: string | null = null;
  let fallbackUsed = false;
  for (const o of perQuery) {
    errors.push(...o.errors);
    attempts.push(...o.attempts);
    if (o.providerUsed && !providersUsed.includes(o.providerUsed)) providersUsed.push(o.providerUsed);
    if (!providerUsed && o.providerUsed) providerUsed = o.providerUsed;
    fallbackUsed = fallbackUsed || o.fallbackUsed;
  }

  const cap = Math.max(0, options.numResults);
  return {
    results: dedupResults(interleaveResults(perQuery.map((o) => o.results))).slice(0, cap),
    providerUsed,
    providersUsed,
    fallbackUsed,
    errors,
    attempts,
  };
}
