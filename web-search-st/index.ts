import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { setStatusBlock } from "../common/status.js";
import {
  defaultProviderChain, searchWithChain, formatSearchFooter, formatSearchMarkdown, fallbackReason,
  type FetchResult, type ProviderOutcome,
} from "./providers.js";
import { DEFAULT_MAX_CHARS, fetchPage } from "./fetcher.js";
import {
  loadWebSearchSettings, saveWebSearchSettings, resolveKey, providerEnabled,
  type WebSearchStSettings,
} from "./settings.js";


// ---------------------------------------------------------------------------
// TUI helpers (copied from pi-web-search) — compact, width-safe rendering.
// ---------------------------------------------------------------------------

const ANSWER_LINE_MAX = 160;
const CALL_ARG_MAX = 2000;
const TITLE_DISPLAY_MAX = 52;
const URL_DISPLAY_MAX = 64;
const RESULT_ITEMS_COLLAPSED = 8;
const RESULT_ITEMS_EXPANDED = 20;

function textComponent(text: string): Text {
  return new Text(text, 0, 0);
}

function safeTruncate(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth).replaceAll("\x1b[0m", "\x1b[22m\x1b[39m");
}

function formatUrl(url: string, maxLen = URL_DISPLAY_MAX): string {
  return safeTruncate(url, maxLen);
}

function formatShort(text: string, maxLen: number): string {
  return safeTruncate(text, maxLen);
}

function formatCallArg(text: string): string {
  return text.length > CALL_ARG_MAX ? safeTruncate(text, CALL_ARG_MAX) : text;
}

/**
 * One line for the running call. Both tools emit exactly one `onUpdate` carrying a phase, and the
 * previous renderers discarded it, so a search (or a fetch with a Chrome hop, up to ~30 s) showed
 * nothing at all and then jumped straight to the finished block. One stable line is also what keeps
 * the row's height from changing 0 -> N when the result lands.
 *
 * The phase label is used rather than the payload's own text (`Searching: "<query>"...`), because
 * the call line directly above already carries the query. No clock: neither payload has a timestamp,
 * and a third timer instance is not worth it.
 */
function progressLine(result: any, theme: Theme): string {
  const phase = typeof result?.details?.phase === "string" ? result.details.phase : "";
  if (phase === "search") return theme.fg("warning", "searching…");
  if (phase === "fetch") return theme.fg("warning", "fetching…");
  const text = (result?.content ?? [])
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  return theme.fg("warning", text || "working…");
}

function pushResultList(
  lines: string[],
  results: Array<{ title?: string; url?: string; snippet?: string }>,
  theme: Theme,
  expanded: boolean,
): void {
  if (results.length === 0) return;
  lines.push("");
  lines.push(theme.fg("toolTitle", "Results:"));
  const maxItems = expanded ? RESULT_ITEMS_EXPANDED : RESULT_ITEMS_COLLAPSED;
  for (let i = 0; i < Math.min(results.length, maxItems); i++) {
    const r = results[i];
    const title = formatShort(r.title || "Untitled", TITLE_DISPLAY_MAX);
    const url = formatUrl(r.url || "", URL_DISPLAY_MAX);
    const num = theme.fg("toolTitle", `${i + 1}.`);
    lines.push(safeTruncate(
      `  ${num} ${theme.fg("accent", title)} ${theme.fg("muted", "—")} ${theme.fg("dim", url)}`,
      ANSWER_LINE_MAX + 20,
    ));
    if (expanded && r.snippet) {
      lines.push(safeTruncate(`      ${theme.fg("dim", r.snippet)}`, ANSWER_LINE_MAX));
    }
  }
  if (results.length > maxItems) {
    lines.push(theme.fg("dim", `  … +${results.length - maxItems} more`));
  }
}

// ---------------------------------------------------------------------------
// Tool access state (same as pi-web-search)
// ---------------------------------------------------------------------------

const WEB_TOOLS = ["web_search", "fetch_content"] as const;
const WEB_ACCESS_STATE_TYPE = "web-access-state";
const PROVIDER_NAMES = ["exa", "bing", "tavily", "brave"] as const;
const PROVIDER_DESCRIPTION =
  "auto, or force one. auto walks exa → keyed brave/tavily → bing.";

interface WebAccessState {
  enabled: boolean;
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function chainConfig(s?: WebSearchStSettings) {
  const settings = s ?? loadWebSearchSettings();
  return {
    BRAVE_API_KEY: resolveKey(process.env.BRAVE_API_KEY, settings.braveKey),
    TAVILY_API_KEY: resolveKey(process.env.TAVILY_API_KEY, settings.tavilyKey),
    chain: settings.chain,
    disabled: settings.disabled,
  };
}

function providerChain(s?: WebSearchStSettings) {
  return defaultProviderChain(chainConfig(s));
}

function providerChainLabel(s?: WebSearchStSettings): string {
  const settings = s ?? loadWebSearchSettings();
  const disabled = new Set(settings.disabled);
  const providers = providerChain(settings);
  const avail = new Map(providers.map((p) => [p.name, p.isAvailable()]));
  const labels = settings.chain.map((name) => {
    if (disabled.has(name)) return `${name}(off)`;
    if (avail.get(name) === false) return `${name}(no key)`;
    return name;
  });
  return labels.join(" → ");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  function sessionEnabled(ctx: ExtensionContext): boolean {
    const state = getLatestWebAccessState(ctx);
    if (state) return state.enabled;
    return loadWebSearchSettings().enabled;
  }

  function applyEnabled(ctx: ExtensionContext, enabled: boolean): void {
    pi.appendEntry(WEB_ACCESS_STATE_TYPE, { enabled });
    const settings = loadWebSearchSettings();
    if (settings.enabled !== enabled) {
      saveWebSearchSettings({ ...settings, enabled });
    }
    syncWebAccessTools(pi, enabled);
    setWebAccessStatus(ctx, enabled);
  }

  function handleSessionChange(ctx: ExtensionContext): void {
    const enabled = sessionEnabled(ctx);
    syncWebAccessTools(pi, enabled);
    setWebAccessStatus(ctx, enabled);
  }

  async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
    const { runWebMenu } = await import("./tui.js");
    await runWebMenu(ctx, {
      getSessionEnabled: () => sessionEnabled(ctx),
      setEnabled: (enabled) => applyEnabled(ctx, enabled),
      getSettings: () => loadWebSearchSettings(),
      saveSettings: (s) => saveWebSearchSettings(s),
      chainPreview: () => providerChainLabel(),
    });
  }

  pi.on("session_start", (_event, ctx) => handleSessionChange(ctx));
  pi.on("session_tree", (_event, ctx) => handleSessionChange(ctx));

  pi.registerCommand("web", {
    description: "Web search settings, or /web on|off",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        applyEnabled(ctx, arg === "on");
        ctx.ui.notify(`Web access ${arg === "on" ? "ON" : "OFF"}`, "info");
        return;
      }
      await openMenu(ctx);
    },
  });

  pi.registerCommand("web-status", {
    description: "Web search settings (keys, chain, default on/off)",
    handler: async (_args, ctx) => {
      await openMenu(ctx);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Web search. Prefer queries. Known URL: fetch_content. Do not retry a provider the footer marks 429.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Single search query. Prefer 'queries' for multi-angle research.",
      })),
      queries: Type.Optional(Type.Array(Type.String(), {
        description: "2-4 related queries with varied phrasing/scope. Preferred for research; they run in parallel.",
      })),
      num_results: Type.Optional(Type.Number({
        description: "Max results after merge. Overrides the 'depth' preset; omit to use the depth default. Multi-query results are interleaved and deduped, then cut to this count.",
      })),
      depth: Type.Optional(StringEnum(["quick", "standard", "deep"], {
        description: "Preset result count used when 'num_results' is not set: 'quick' = 5, 'standard' = 10, 'deep' = 15.",
      })),
      recency_filter: Type.Optional(StringEnum(["day", "week", "month", "year"], {
        description: "Limit results by recency (honored by brave/tavily only).",
      })),
      domain_filter: Type.Optional(Type.Array(Type.String(), {
        description: "Include domains like ['docs.python.org'] or exclude with ['-medium.com']. Includes are OR. Exa ignores it; auto then prefers brave/tavily/bing.",
      })),
      provider: Type.Optional(StringEnum(["auto", ...PROVIDER_NAMES], {
        description: PROVIDER_DESCRIPTION,
      })),
      fallback: Type.Optional(Type.Boolean({
        description: "Allow falling through the chain on provider error/empty. Default true.",
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
          isError: true,
        };
      }

      const q = queryList.join(" ");
      onUpdate?.({
        content: [{ type: "text" as const, text: `Searching: "${q}"...` }],
        details: { phase: "search", currentQuery: q },
      });

      try {
        const depthDefault: Record<string, number> = { quick: 5, standard: 10, deep: 15 };
        const numResults = params.num_results ?? depthDefault[params.depth ?? "standard"] ?? 10;
        const settings = loadWebSearchSettings();
        const outcome: ProviderOutcome = await searchWithChain(queryList, {
          numResults,
          recencyFilter: params.recency_filter,
          domainFilter: params.domain_filter,
          preferredProvider: params.provider,
          allowFallback: params.fallback ?? settings.fallback,
          signal,
        }, providerChain(settings));

        const footer = formatSearchFooter(outcome);
        const content = formatSearchMarkdown(outcome.results, footer);

        return {
          content: [{ type: "text" as const, text: content }],
          details: {
            provider_used: outcome.providerUsed,
            providers_used: outcome.providersUsed,
            result_count: outcome.results.length,
            fallback_used: outcome.fallbackUsed,
            fallback_reason: fallbackReason(outcome.attempts),
            errors: outcome.errors,
            results: outcome.results,
            footer,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Web search error: ${msg}` }],
          details: { error: msg },
          isError: true,
        };
      }
    },

    renderCall(args, theme, context: { argsComplete?: boolean } = {}) {
      const input = args as {
        query?: unknown;
        queries?: unknown;
        depth?: string;
        num_results?: number;
        recency_filter?: string;
        domain_filter?: string[];
        provider?: string;
        fallback?: boolean;
      };
      const rawQueryList: unknown[] = Array.isArray(input.queries)
        ? input.queries
        : (input.query !== undefined ? [input.query] : []);
      const queryList = normalizeQueryList(rawQueryList);

      if (queryList.length === 0) {
        // While the arguments stream there is no query yet, on every single call: a muted placeholder
        // then, and the red text only for a call whose arguments arrived without one (schema miss).
        const empty = context.argsComplete === true
          ? theme.fg("error", "(no query)")
          : theme.fg("muted", "...");
        return textComponent(theme.fg("toolTitle", theme.bold("search ")) + empty);
      }

      const badges: string[] = [];
      if (input.depth && input.depth !== "standard") badges.push(input.depth);
      if (input.num_results != null && input.num_results !== 10) badges.push(`${input.num_results}`);
      if (input.recency_filter) badges.push(input.recency_filter);
      if (input.provider && input.provider !== "auto") badges.push(input.provider);
      if (input.fallback === false) badges.push("no-fallback");
      if (input.domain_filter && input.domain_filter.length > 0) {
        badges.push(input.domain_filter.length === 1 ? input.domain_filter[0] : `${input.domain_filter.length} domains`);
      }

      const lines: string[] = [];
      let label = theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${formatCallArg(queryList[0])}"`);
      if (badges.length > 0) {
        label += theme.fg("dim", ` · ${badges.join(" · ")}`);
      }
      lines.push(label);
      for (const qq of queryList.slice(1)) {
        lines.push(theme.fg("dim", "+ ") + theme.fg("accent", `"${formatCallArg(qq)}"`));
      }
      return textComponent(lines.join("\n"));
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return textComponent(progressLine(result, theme));
      }
      const details = result.details as {
        error?: string;
        provider_used?: string;
        providers_used?: string[];
        result_count?: number;
        fallback_used?: boolean;
        fallback_reason?: string;
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      } | undefined;

      if (details?.error && !details.result_count) {
        return textComponent(theme.fg("error", `Error: ${details.error}`));
      }

      const count = details?.result_count ?? 0;
      const via = (details?.providers_used && details.providers_used.length > 0)
        ? details.providers_used.join("+")
        : (details?.provider_used ?? "unknown");

      let line = theme.fg("success", `${count} sources`) + theme.fg("muted", ` via ${via}`);
      if (details?.fallback_used) {
        const why = details.fallback_reason ? `: ${details.fallback_reason}` : "";
        line += theme.fg("dim", ` · fallback${why}`);
      }

      const lines: string[] = [line];
      pushResultList(lines, details?.results ?? [], theme, expanded);

      return textComponent(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch URL markdown. Overflow is in %TEMP% — read that file, do not re-fetch. " +
      "GitHub /blob/ is raw. A Chrome hop may take ~30s: do not fire a second fetch in parallel; on a challenge tab, ask the user, then re-fetch once.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({
        description: "Single URL to fetch.",
      })),
      urls: Type.Optional(Type.Array(Type.String(), {
        description: "Multiple URLs to fetch in parallel (errors stay isolated per URL).",
      })),
      max_chars: Type.Optional(Type.Number({
        minimum: 1000,
        description: `Inline cap. Default ${DEFAULT_MAX_CHARS}, minimum 1000.`,
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const urlList = params.urls ?? (params.url ? [params.url] : []);
      if (urlList.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: No URL provided." }],
          details: { error: "No URL provided" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: `Fetching ${urlList.length} URL(s)...` }],
        details: { phase: "fetch", urlCount: urlList.length },
      });

      try {
        const maxChars = Math.max(params.max_chars ?? DEFAULT_MAX_CHARS, 1000);
        const settings = loadWebSearchSettings();
        const exaOn = providerEnabled(settings.disabled, "exa");
        const browserOn = settings.browserFallback;

        const settled = await Promise.all(urlList.map(async (url) => {
          try {
            const fr = await fetchPage(url, { maxChars, signal, exaEnabled: exaOn, browserEnabled: browserOn });
            return { ok: true as const, fr };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false as const, url, error: msg };
          }
        }));

        const contentParts: string[] = [];
        const metaList: Array<{
          url: string;
          title?: string;
          status_code?: number;
          chars_returned?: number;
          truncated?: boolean;
          source_provider?: string;
          attempts?: string[];
        }> = [];
        const paths: (string | null)[] = [];
        const providersUsed: string[] = [];
        const errors: string[] = [];
        let fallbackUsed = false;

        for (const item of settled) {
          if (!item.ok) {
            errors.push(item.error);
            contentParts.push(`Failed to fetch: ${item.url}\n${item.error}`);
            metaList.push({ url: item.url, status_code: 0 });
            continue;
          }
          const fr: FetchResult = item.fr;
          const hops = fr.attempts ?? [];
          if (hops.length > 1) fallbackUsed = true;
          if (fr.sourceProvider && !providersUsed.includes(fr.sourceProvider)) {
            providersUsed.push(fr.sourceProvider);
          }
          const body = fr.sourceProvider === "exa"
            ? fr.content.replace(/^#\s[^\n]+\nURL:\s[^\n]+\n+(?:_via [^\n]+_\n+)?/, "")
            : fr.content;
          contentParts.push(`# ${fr.title}\nURL: ${fr.url}\n_via ${fr.sourceProvider}_\n\n${body}`);
          metaList.push({
            url: fr.url,
            title: fr.title,
            status_code: fr.statusCode,
            chars_returned: Math.min(fr.content.length, maxChars),
            truncated: fr.truncated,
            source_provider: fr.sourceProvider,
            attempts: hops,
          });
          paths.push(fr.fullContentPath);
        }

        return {
          content: [{ type: "text" as const, text: contentParts.join("\n\n---\n\n") }],
          details: {
            results: metaList,
            max_chars: maxChars,
            full_content_paths: paths,
            provider_used: providersUsed.join("+") || undefined,
            fallback_used: fallbackUsed,
            errors,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Fetch error: ${msg}` }],
          details: { error: msg },
          isError: true,
        };
      }
    },

    renderCall(args, theme, context: { argsComplete?: boolean } = {}) {
      const input = args as { url?: string; urls?: string[]; max_chars?: number };
      const urlList = input.urls ?? (input.url ? [input.url] : []);
      if (urlList.length === 0) {
        const empty = context.argsComplete === true
          ? theme.fg("error", "(no URL)")
          : theme.fg("muted", "...");
        return textComponent(theme.fg("toolTitle", theme.bold("fetch ")) + empty);
      }

      const badges: string[] = [];
      if (input.max_chars != null && input.max_chars !== DEFAULT_MAX_CHARS) badges.push(`${input.max_chars} chars`);

      const lines: string[] = [];
      let label = theme.fg("toolTitle", theme.bold("fetch "))
        + theme.fg("accent", urlList.length === 1 ? formatCallArg(urlList[0]) : `${urlList.length} URLs`);
      if (badges.length > 0) {
        label += theme.fg("dim", ` · ${badges.join(" · ")}`);
      }
      lines.push(label);
      if (urlList.length > 1) {
        for (const u of urlList.slice(0, 5)) {
          lines.push(theme.fg("dim", "+ ") + theme.fg("accent", formatCallArg(u)));
        }
        if (urlList.length > 5) {
          lines.push(theme.fg("dim", `+ ${urlList.length - 5} more URLs`));
        }
      }
      return textComponent(lines.join("\n"));
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return textComponent(progressLine(result, theme));
      }
      const details = result.details as {
        error?: string;
        results?: Array<{
          url: string;
          title?: string;
          status_code?: number;
          chars_returned?: number;
          truncated?: boolean;
          source_provider?: string;
        }>;
        max_chars?: number;
        full_content_paths?: (string | null)[];
        provider_used?: string;
        fallback_used?: boolean;
      } | undefined;
      if (details?.error && !details.results?.length) {
        return textComponent(theme.fg("error", `Error: ${details.error}`));
      }
      const results = details?.results ?? [];
      const count = results.length || 1;
      const limit = details?.max_chars ?? DEFAULT_MAX_CHARS;
      const truncatedCount = results.filter((r) => r.truncated).length;
      const failedCount = results.filter((r) => r.status_code != null && r.status_code === 0).length;

      let line = theme.fg("success", `${count} URL(s) fetched`) + theme.fg("muted", ` · limit ${limit} chars`);
      if (details?.provider_used) line += theme.fg("muted", ` · via ${details.provider_used}`);
      if (details?.fallback_used) line += theme.fg("dim", " · fallback");
      if (truncatedCount > 0) line += theme.fg("warning", ` · ${truncatedCount} truncated`);
      if (failedCount > 0) line += theme.fg("error", ` · ${failedCount} failed`);
      if (!expanded) return textComponent(line);

      const lines: string[] = [line];
      for (const r of results) {
        const title = formatShort(r.title || "Untitled", TITLE_DISPLAY_MAX);
        const url = formatUrl(r.url, URL_DISPLAY_MAX);
        const status = r.status_code === 0
          ? theme.fg("error", "fail")
          : theme.fg("muted", `${r.status_code ?? "ok"}`);
        const via = r.source_provider ? theme.fg("dim", ` ${r.source_provider}`) : "";
        const chars = theme.fg("muted", `${r.chars_returned ?? "?"} chars`);
        const truncated = r.truncated ? theme.fg("warning", " truncated") : "";
        lines.push(safeTruncate(
          `${status}${via} ${theme.fg("accent", title)} ${theme.fg("muted", "—")} ${theme.fg("dim", url)} ${chars}${truncated}`,
          ANSWER_LINE_MAX + 20,
        ));
      }

      const savedPaths = (details?.full_content_paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
      if (savedPaths.length > 0) {
        lines.push(theme.fg("accent", "Saved full content:"));
        for (const p of savedPaths) lines.push(safeTruncate(theme.fg("dim", `  ${p}`), ANSWER_LINE_MAX + 20));
      }

      return textComponent(lines.join("\n"));
    },
  });
}
