import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const OLLAMA_API_BASE = "https://ollama.com/api";

async function getApiKey(ctx?: ExtensionContext): Promise<string> {
  const configured = await ctx?.modelRegistry?.authStorage?.getApiKey("ollama", { includeFallback: true });
  if (configured?.trim()) return configured.trim();

  // 1. Самый безопасный и явный вариант: переменная среды
  const envKey = process.env.OLLAMA_API_KEY?.trim();
  if (envKey) return envKey;

  // 2. Удобный вариант: взять из ~/.pi/agent/auth.json
  const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");

  if (!fs.existsSync(authPath)) {
    throw new Error(
      "OLLAMA_API_KEY is not set and ~/.pi/agent/auth.json was not found."
    );
  }

  const raw = fs.readFileSync(authPath, "utf8");
  const auth = JSON.parse(raw);

  const key = auth?.ollama?.key;

  if (typeof key !== "string" || !key.trim()) {
    throw new Error(
      "OLLAMA_API_KEY is not set and auth.json does not contain ollama.key."
    );
  }

  return key.trim();
}

function truncateText(text: string, maxChars = 12000): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[truncated: ${text.length - maxChars} chars omitted]`;
}

function formatSearchResults(data: any): string {
  const results =
    data?.results ??
    data?.items ??
    data?.organic ??
    data?.data ??
    [];

  if (!Array.isArray(results) || results.length === 0) {
    return [
      "WEB_SEARCH_RESULTS",
      "No structured results found.",
      "",
      "RAW:",
      truncateText(JSON.stringify(data, null, 2), 4000)
    ].join("\n");
  }

  const lines = ["WEB_SEARCH_RESULTS"];

  results.slice(0, 10).forEach((item: any, index: number) => {
    const title =
      item.title ??
      item.name ??
      item.heading ??
      "Untitled";

    const url =
      item.url ??
      item.link ??
      item.href ??
      item.source ??
      "";

    const snippet =
      item.snippet ??
      item.description ??
      item.summary ??
      item.text ??
      "";

    lines.push("");
    lines.push(`${index + 1}. ${title}`);
    if (url) lines.push(`URL: ${url}`);
    if (snippet) lines.push(`Snippet: ${truncateText(String(snippet), 700)}`);
  });

  lines.push("");
  lines.push("Instruction: choose the most relevant result URL. Prefer official documentation, GitHub repositories, and vendor docs over blogs or mirrors.");

  return lines.join("\n");
}

function formatFetchResult(data: any): string {
  const title =
    data?.title ??
    data?.metadata?.title ??
    "Untitled";

  const url =
    data?.url ??
    data?.metadata?.url ??
    data?.source ??
    "";

  const content =
    data?.content ??
    data?.text ??
    data?.markdown ??
    data?.body ??
    data?.data ??
    JSON.stringify(data, null, 2);

  return [
    "WEB_FETCH_RESULT",
    "",
    `Title: ${title}`,
    url ? `URL: ${url}` : "",
    "",
    "Content:",
    truncateText(String(content), 16000)
  ].filter(Boolean).join("\n");
}

async function postOllama(path: string, body: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<unknown> {
  const apiKey = await getApiKey(ctx);

  const response = await fetch(`${OLLAMA_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query." }),
  max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return. Default: 5." })),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch." }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using Ollama Cloud web_search. Use this for current information, official docs, discussions, reviews, and finding relevant URLs.",
    promptSnippet: "web_search: search the web for current information and URLs.",
    promptGuidelines: [
      "Use web_search when the user asks for current information, official docs, recent discussions, reviews, or unknown URLs.",
      "After web_search, use web_fetch on the most relevant result when the user needs details from a page."
    ],
    parameters: WebSearchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = String(params.query ?? "").trim();
      const maxResults = Number(params.max_results ?? 5);

      if (!query) {
        throw new Error("query is required");
      }

      const data = await postOllama("/web_search", {
        query,
        max_results: Math.max(1, Math.min(maxResults, 10))
      }, signal, ctx);

      const output = formatSearchResults(data);

      return {
        content: [{ type: "text", text: output }],
        details: data
      };
    }
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page using Ollama Cloud web_fetch. Use this to read a known URL and extract page content.",
    promptSnippet: "web_fetch: fetch and read a web page by URL.",
    promptGuidelines: [
      "Use web_fetch when the user gives a URL or after web_search finds a relevant URL.",
      "Prefer web_fetch over bash curl for reading web pages."
    ],
    parameters: WebFetchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const url = String(params.url ?? "").trim();

      if (!url) {
        throw new Error("url is required");
      }

      const data = await postOllama("/web_fetch", { url }, signal, ctx);
      const output = formatFetchResult(data);

      return {
        content: [{ type: "text", text: output }],
        details: data
      };
    }
  });
}
