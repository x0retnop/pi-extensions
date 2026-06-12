import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { fetchAllContent, type ExtractedContent } from "./extract.js";
import { clearCloneCache } from "./github-extract.js";
import { search } from "./search-orchestrator.js";
import { executeCodeSearch } from "./code-search.js";
import type { SearchResult } from "./search-orchestrator.js";
import { loadSettings, saveSettings, getApiKey, setApiKey, maskKey, clearConfigCache, type SearchProvider } from "./config.js";

import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	restoreFromSession,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.js";
import { activityMonitor, type ActivityEntry } from "./activity.js";

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

let sessionActive = false;
let sessionSearchCount = 0;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

const MAX_INLINE_CONTENT = 30000;

function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function duplicateQuerySet(results: QueryResultData[]): Set<string> {
	const counts = new Map<string, number>();
	for (const result of results) {
		counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
	}
	const duplicates = new Set<string>();
	for (const [query, count] of counts) {
		if (count > 1) duplicates.add(query);
	}
	return duplicates;
}

function formatQueryHeader(query: string, provider: string | undefined, duplicateQueries: Set<string>): string {
	const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
	return `## Query: "${query}"${suffix}\n\n`;
}

function getDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function analyzeSources(results: SearchResult[]) {
	const counts = new Map<string, number>();
	let hasOfficial = false;
	let hasPrimary = false;
	const newsDomains = new Set<string>();

	const officialHosts = new Set(["github.com", "openai.com", "anthropic.com", "about.gitlab.com", "blog.google", "developers.googleblog.com", "cloud.google.com"]);
	const primaryHosts = new Set(["sec.gov", "courtlistener.com", "arxiv.org", "storage.courtlistener.com"]);

	for (const r of results) {
		const domain = getDomain(r.url);
		counts.set(domain, (counts.get(domain) ?? 0) + 1);

		const isOfficial = officialHosts.has(domain) || domain.startsWith("docs.") || domain.startsWith("developers.") || domain.startsWith("support.") || domain.startsWith("developer.");
		const isPrimary = primaryHosts.has(domain) || domain.endsWith(".gov") || domain.endsWith(".europa.eu");
		if (isOfficial) hasOfficial = true;
		if (isPrimary) hasPrimary = true;
		if (!isOfficial && !isPrimary) newsDomains.add(domain);
	}

	let topDomain = "";
	let topCount = 0;
	for (const [d, c] of counts) {
		if (c > topCount) {
			topCount = c;
			topDomain = d;
		}
	}
	const topShare = results.length > 0 ? Math.round((topCount / results.length) * 100) : 0;

	return { topDomain, topShare, hasOfficial, hasPrimary, newsDomains: newsDomains.size };
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];

	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			lines.push("  " + formatEntryLine(e, theme));
		}
	}

	lines.push(theme.fg("accent", "─".repeat(60)));

	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	const resetSec = Math.ceil(resetMs / 1000);
	lines.push(
		theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
			(resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
	);

	ctx.ui.setWidget("web-activity", lines);
}

function formatEntryLine(
	entry: ActivityEntry,
	theme: any,
): string {
	const typeStr = entry.type === "api" ? "API" : "GET";
	const target =
		entry.type === "api"
			? `"${truncateToWidth(entry.query || "", 28, "")}"`
			: truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

	const duration = entry.endTime
		? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
		: `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

	let statusStr: string;
	let indicator: string;
	if (entry.error) {
		statusStr = "err";
		indicator = theme.fg("error", "✗");
	} else if (entry.status === null) {
		statusStr = "...";
		indicator = theme.fg("warning", "⋯");
	} else if (entry.status === 0) {
		statusStr = "abort";
		indicator = theme.fg("muted", "○");
	} else {
		statusStr = String(entry.status);
		indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	}

	return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

function handleSessionChange(ctx: ExtensionContext): void {
	clearCloneCache();
	sessionActive = true;
	sessionSearchCount = 0;
	restoreFromSession(ctx);
	widgetUnsubscribe?.();
	widgetUnsubscribe = null;
	activityMonitor.clear();
	if (widgetVisible) {
		widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	}
}

export default function (pi: ExtensionAPI) {

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
		depth?: string;
		researchRound: number;
	}

	function buildSearchReturn(opts: SearchReturnOptions) {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		let output = "";
		const duplicateQueries = duplicateQuerySet(opts.results);
		for (const { query, answer, results, error, provider } of opts.results) {
			if (opts.queryList.length > 1) {
				output += formatQueryHeader(query, provider, duplicateQueries);
			}
			if (error) output += `Error: ${error}\n\n`;
			else if (results.length === 0) output += "No results found.\n\n";
			else output += formatSearchSummary(results, answer) + "\n\n";
		}

		if (opts.inlineContent && opts.inlineContent.length > 0) {
			output += `---\nFull page content included for ${opts.inlineContent.length} source(s).\n`;
		}

		const totalResults = tr;
		const successfulQueries = sc;
		const isSparse = totalResults < 5 || opts.results.some(r => !r.error && r.results.length < 2);
		const hasErrors = opts.results.some(r => r.error);
		const allEmpty = successfulQueries === 0;

		output += "\n\n---\n";
		output += `**Research Round ${opts.researchRound}** • Depth: ${opts.depth ?? "standard"}\n`;
		if (allEmpty) {
			output += `⚠️ No results. Try alternate phrasing, remove domain filters, or check recencyFilter.\n`;
		} else if (isSparse) {
			output += `⚠️ Sparse coverage (${totalResults} sources). Consider follow-up queries with broader or alternate phrasing.\n`;
		} else {
			output += `Coverage: ${totalResults} sources from ${successfulQueries}/${opts.queryList.length} queries. `;
			if (opts.depth === "deep") {
				output += `Deep mode: verify if primary sources, official docs, and opposing views are represented. If not, continue with targeted follow-ups.\n`;
			} else {
				output += `If this is a technical or controversial topic, consider a deeper round with \`depth: "deep"\` or additional queries.\n`;
			}
		}
		if (hasErrors) {
			output += `Some queries encountered errors — retry failed angles if needed.\n`;
		}

		if (!allEmpty) {
			const allResultsFlat = opts.results.flatMap(r => r.results);
			const { topDomain, topShare, hasOfficial, hasPrimary, newsDomains } = analyzeSources(allResultsFlat);
			output += `\n**Source mix:** `;
			const parts: string[] = [];
			if (topShare > 40) parts.push(`${topShare}% from ${topDomain}`);
			if (hasOfficial) parts.push("official docs present");
			else parts.push("no official docs");
			if (hasPrimary) parts.push("primary sources present");
			else parts.push("no primary sources");
			parts.push(`${newsDomains} independent outlets`);
			output += parts.join(" • ") + "\n";
			if (topShare > 40) {
				output += `⚠️ Heavy reliance on ${topDomain}. Diversify with independent or official sources in follow-ups.\n`;
			}
			if (!hasOfficial && opts.depth !== "quick") {
				output += `→ Missing official sources. Try site:github.com or site:company.com in next queries.\n`;
			}
			if (!hasPrimary && opts.depth === "deep") {
				output += `→ Missing primary/regulatory sources. Consider SEC, court, or research papers for fact-checking.\n`;
			}
		}

		storeAndPublishSearch(opts.results);

		return {
			content: [{ type: "text" as const, text: output.trim() }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				depth: opts.depth,
				researchRound: opts.researchRound,
			},
		};
	}

	pi.registerCommand("web-config", {
		description: "Configure web search provider and API keys",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (sub === "provider") {
				const name = parts[1]?.toLowerCase() as SearchProvider;
				if (!name || !["auto", "exa-mcp", "exa-api", "ollama"].includes(name)) {
					ctx.ui.notify("Usage: /web-config provider auto|exa-mcp|exa-api|ollama", "warning");
					return;
				}
				saveSettings({ searchProvider: name });
				clearConfigCache();
				ctx.ui.notify(`Search provider set to: ${name}`, "info");
				return;
			}

			if (sub === "exa-key") {
				const key = parts[1];
				if (!key) {
					ctx.ui.notify("Usage: /web-config exa-key <api-key>", "warning");
					return;
				}
				setApiKey("exa", key);
				clearConfigCache();
				ctx.ui.notify("Exa API key saved.", "info");
				return;
			}

			if (sub === "ollama-key") {
				const key = parts[1];
				if (!key) {
					ctx.ui.notify("Usage: /web-config ollama-key <api-key>", "warning");
					return;
				}
				setApiKey("ollama", key);
				clearConfigCache();
				ctx.ui.notify("Ollama API key saved.", "info");
				return;
			}

			if (sub === "show") {
				const settings = loadSettings();
				const exaKey = maskKey(getApiKey("exa"));
				const ollamaKey = maskKey(getApiKey("ollama"));
				ctx.ui.notify(
					`Provider: ${settings.searchProvider}\n` +
					`Exa key: ${exaKey}\n` +
					`Ollama key: ${ollamaKey}`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage:\n" +
				"  /web-config provider auto|exa-mcp|exa-api|ollama\n" +
				"  /web-config exa-key <key>\n" +
				"  /web-config ollama-key <key>\n" +
				"  /web-config show",
				"info",
			);
		},
	});

	pi.registerCommand("pi-web-activity", {
		description: "Toggle web search activity widget on/off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") widgetVisible = true;
			else if (arg === "off") widgetVisible = false;
			else widgetVisible = !widgetVisible;

			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
				ctx.ui.notify("Activity monitor ON", "info");
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
				ctx.ui.notify("Activity monitor OFF", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		sessionActive = false;
		clearCloneCache();
		clearResults();
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		activityMonitor.clear();
		widgetVisible = false;
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for current information, official docs, discussions, or URLs. Returns a synthesized answer with source citations. One call = one research round.",
		promptSnippet:
			"Use when you need current information, docs, or URLs not in your context. One call = one round.",
		promptGuidelines: [
			"Use when the user asks for something outside your training context: current events, specific docs, URLs, or facts you do not know.",
			"Returns a short answer plus a list of source URLs. Read a specific URL with fetch_content if the user needs full page text.",
			"Set includeContent:true if you need the full text of result pages immediately (slower but no follow-up call needed).",
			"For broad or technical topics, use queries (array) with 2-4 different angles instead of a single query.",
			"Do not use for programming examples or API docs — use code_search for those.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 10, max: 20). Increase for broad or contentious topics." })),
			includeContent: Type.Optional(Type.Boolean({ description: "Return full page content inline for each result URL. Slower, but avoids a separate fetch_content call." })),
			depth: Type.Optional(StringEnum(["quick", "standard", "deep"], { description: "Research depth. 'quick' = 5 sources, 'standard' = 10, 'deep' = 15+ and encourages follow-up rounds." })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter results by recency. Use 'day' or 'week' for news and trends; 'month' or 'year' for broader context." }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude). Use ['github.com'] for code, ['docs.*'] for official docs, ['-stackoverflow.com'] to avoid Stack Overflow." })),
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

			const depth = params.depth ?? "standard";
			const researchRound = ++sessionSearchCount;

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text" as const, text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(query, {
						numResults: params.numResults,
						recencyFilter: params.recencyFilter as any,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						depth,
						signal,
					});

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					searchResults.push({ query, answer: "", results: [], error: message, provider: undefined });
				}
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				depth,
				researchRound,
			});
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
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				depth?: string;
				researchRound?: number;
				phase?: string;
				progress?: number;
				currentQuery?: string;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				const query = details?.currentQuery || "";
				const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
				return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			const roundInfo = details?.researchRound ? ` (round ${details.researchRound}${details?.depth && details.depth !== "standard" ? `, ${details.depth}` : ""})` : "";
			statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`) + theme.fg("muted", roundInfo);

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description: "Search for code examples, documentation, and API references. Returns concrete code snippets and docs.",
		promptSnippet:
			"Use for programming questions: API usage, library examples, code snippets, debugging.",
		promptGuidelines: [
			"Use when the user asks about code: API usage, library examples, implementations, or debugging.",
			"Returns code snippets and documentation. Not for general web search, news, or discussions.",
			"If results are insufficient, fall back to web_search for broader coverage.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Programming question, API, library, or debugging topic to search for" }),
			maxTokens: Type.Optional(Type.Integer({
				minimum: 1000,
				maximum: 50000,
				description: "Maximum tokens of code/documentation context to return (default: 5000)",
			})),
		}),

		async execute(toolCallId, params, signal) {
			return executeCodeSearch(toolCallId, params, signal);
		},

		renderCall(args, theme) {
			const { query } = args as { query?: string };
			const display = !query
				? "(no query)"
				: query.length > 70 ? query.slice(0, 67) + "..." : query;
			return new Text(theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("accent", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { query?: string; maxTokens?: number; error?: string };
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const summary = theme.fg("success", "code context returned") +
				theme.fg("muted", ` (${details?.maxTokens ?? 5000} tokens max)`);
			if (!expanded) return new Text(summary, 0, 0);

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch a URL and extract its readable content as markdown. Supports GitHub repos (auto-clone or API view). Falls back to Ollama Cloud for bot-blocked pages.",
		promptSnippet:
			"Use to read a specific URL or GitHub repo in full. Prefer single URL per call for complete text.",
		promptGuidelines: [
			"Use when the user gives a URL, or when web_search found a URL that needs detailed reading.",
			"Single URL calls return the full page text inline. Multi-URL calls return only summaries.",
			"GitHub URLs are automatically cloned when possible; otherwise an API view is returned.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
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
				details: { phase: "fetch", progress: 0 },
			});

			const fetchResults = await fetchAllContent(urlList, signal, {
				forceClone: params.forceClone,
			});
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);

			const responseId = generateId();
			const data: StoredSearchData = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: fetchResults,
			};
			storeResult(responseId, data);
			pi.appendEntry("web-search-results", data);

			if (urlList.length === 1) {
				const result = fetchResults[0];
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Error: ${result.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId },
					};
				}

				const fullLength = result.content.length;
				const truncated = fullLength > MAX_INLINE_CONTENT;
				let output = truncated
					? result.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated...]"
					: result.content;

				if (truncated) {
					output += `\n\n---\nShowing ${MAX_INLINE_CONTENT} of ${fullLength} chars. Call fetch_content again if you need the rest.`;
				}

				return {
					content: [{ type: "text" as const, text: output }],
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						responseId,
						truncated,
					},
				};
			}

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += `\n---\nTo read full text of a specific URL, call fetch_content with that URL individually.`;

			return {
				content: [{ type: "text" as const, text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId },
			};
		},

		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const urlList = urls ?? (url ? [url] : []);
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`);
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const lines = [statusLine];
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content stored)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && r.urls) {
					return `[${r.id.slice(0, 6)}] ${r.urls.length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && selected.urls) {
					info += "URLs:\n";
					const urls = selected.urls.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						info += `- ${urlDisplay} (${u.error || `${u.content.length} chars`})\n`;
					}
					if (selected.urls.length > 10) {
						info += `... and ${selected.urls.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
