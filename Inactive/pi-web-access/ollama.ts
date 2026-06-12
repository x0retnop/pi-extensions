import { activityMonitor } from "./activity.js";
import { getApiKey } from "./config.js";
import type { ExtractedContent } from "./extract.js";
import type { SearchResponse } from "./search-orchestrator.js";

const OLLAMA_API_BASE = "https://ollama.com/api";
const REQUEST_TIMEOUT_MS = 60_000;

function withTimeout(parent?: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Ollama request timeout")), REQUEST_TIMEOUT_MS);
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", () => controller.abort(), { once: true });
	}
	// Note: we don't clean up timer on normal completion here because callers must handle it.
	// For simplicity, rely on AbortController garbage collection.
	return controller.signal;
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function resolveApiKey(): string {
	const key = getApiKey("ollama");
	if (!key) {
		throw new Error(
			"Ollama API key not configured. Set it with: /web-config ollama-key <key>\n" +
			"Or set OLLAMA_API_KEY environment variable."
		);
	}
	return key;
}

async function postOllama(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
	const apiKey = resolveApiKey();
	const timeoutSignal = withTimeout(signal);

	const res = await fetch(`${OLLAMA_API_BASE}${path}`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: timeoutSignal,
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Ollama API error ${res.status}: ${text.slice(0, 300)}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function truncate(text: string, maxChars = 12000): string {
	if (!text || text.length <= maxChars) return text;
	return text.slice(0, maxChars) + `\n\n[truncated: ${text.length - maxChars} chars omitted]`;
}

function mapSearchResults(data: unknown): SearchResponse {
	const anyData = data as Record<string, unknown> | undefined;
	const rawResults =
		anyData?.results ??
		anyData?.items ??
		anyData?.organic ??
		anyData?.data ??
		[];

	if (!Array.isArray(rawResults) || rawResults.length === 0) {
		return {
			answer: "",
			results: [],
		};
	}

	const answerParts: string[] = [];
	const results = rawResults.slice(0, 10).map((item: unknown, index: number) => {
		const it = item as Record<string, unknown>;
		const title = String(it?.title ?? it?.name ?? it?.heading ?? `Result ${index + 1}`);
		const url = String(it?.url ?? it?.link ?? it?.href ?? it?.source ?? "");
		const snippet = String(it?.snippet ?? it?.description ?? it?.summary ?? it?.text ?? "");
		if (snippet) {
			answerParts.push(`${snippet}\nSource: ${title} (${url})`);
		}
		return { title, url, snippet: truncate(snippet, 700) };
	});

	return {
		answer: answerParts.join("\n\n"),
		results,
	};
}

export async function searchWithOllama(
	query: string,
	options: { numResults?: number; signal?: AbortSignal },
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query: `ollama: ${query}` });
	try {
		const data = await postOllama("/web_search", {
			query,
			max_results: Math.max(1, Math.min(options.numResults ?? 10, 20)),
		}, options.signal);
		activityMonitor.logComplete(activityId, 200);
		return mapSearchResults(data);
	} catch (err) {
		const message = formatError(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

export async function fetchWithOllama(url: string, signal?: AbortSignal): Promise<ExtractedContent | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `ollama fetch: ${url}` });
	try {
		const data = await postOllama("/web_fetch", { url }, signal);
		activityMonitor.logComplete(activityId, 200);

		const anyData = data as Record<string, unknown> | undefined;
		const metadata = anyData?.metadata as Record<string, unknown> | undefined;
		const title = String(anyData?.title ?? metadata?.title ?? "Untitled");
		const content =
			String(anyData?.content ?? anyData?.text ?? anyData?.markdown ?? anyData?.body ?? "");

		if (!content || content.length < 50) return null;

		return { url, title, content: truncate(content, 16000), error: null };
	} catch (err) {
		const message = formatError(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
