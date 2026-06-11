import { activityMonitor } from "./activity.js";
import { loadSettings, getApiKey, type SearchProvider } from "./config.js";
import { searchWithExa, searchWithExaMcp } from "./exa.js";
import { searchWithOllama } from "./ollama.js";

export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: { url: string; title: string; content: string; error: string | null }[];
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
	depth?: string;
	includeContent?: boolean;
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function isExhaustedError(err: unknown): boolean {
	const m = errorMessage(err).toLowerCase();
	return m.includes("exhausted") || m.includes("monthly free tier");
}

export async function search(
	query: string,
	options: FullSearchOptions = {},
): Promise<AttributedSearchResponse> {
	const config = loadSettings();
	const provider = options.provider ?? config.searchProvider;
	const searchOptions: SearchOptions = {
		...options,
		numResults:
			options.numResults ??
			(options.depth === "deep" ? 15 : options.depth === "quick" ? 5 : 10),
	};

	// --- Explicit provider modes ---
	if (provider === "exa-api") {
		const result = await searchWithExa(query, searchOptions);
		if (result && "exhausted" in result) {
			throw new Error(
				"Exa monthly limit reached. Set provider to 'exa-mcp' or 'ollama', or wait until next month.",
			);
		}
		if (result && "answer" in result) return { ...result, provider: "exa-api" };
		throw new Error("Exa API returned no results.");
	}

	if (provider === "exa-mcp") {
		const result = await searchWithExaMcp(query, searchOptions);
		if (!result) throw new Error("Exa MCP returned no results.");
		return { ...result, provider: "exa-mcp" };
	}

	if (provider === "ollama") {
		const result = await searchWithOllama(query, {
			numResults: searchOptions.numResults,
			signal: searchOptions.signal,
		});
		return { ...result, provider: "ollama" };
	}

	// --- Auto mode fallback chain ---
	const errors: string[] = [];

	// 1. Exa API (paid, best quality)
	const exaKey = getApiKey("exa");
	if (exaKey) {
		try {
			const result = await searchWithExa(query, searchOptions);
			if (result && "answer" in result) return { ...result, provider: "exa-api" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			if (!isExhaustedError(err)) errors.push(`Exa API: ${errorMessage(err)}`);
		}
	}

	// 2. Exa MCP (zero-config)
	try {
		const result = await searchWithExaMcp(query, searchOptions);
		if (result) return { ...result, provider: "exa-mcp" };
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Exa MCP: ${errorMessage(err)}`);
	}

	// 3. Ollama Cloud
	const ollamaKey = getApiKey("ollama");
	if (ollamaKey) {
		try {
			const result = await searchWithOllama(query, {
				numResults: searchOptions.numResults,
				signal: searchOptions.signal,
			});
			return { ...result, provider: "ollama" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			errors.push(`Ollama: ${errorMessage(err)}`);
		}
	}

	// 4. Nothing worked
	const errorBlock = errors.length ? `\n  - ${errors.join("\n  - ")}` : "";
	throw new Error(
		`No search provider available.${errorBlock}\n\n` +
			`Configure one:\n` +
			`  • Exa API key: /web-config exa-key <key>\n` +
			`  • Ollama key:  /web-config ollama-key <key>\n` +
			`  • Or use 'exa-mcp' (no key needed): /web-config provider exa-mcp`,
	);
}
