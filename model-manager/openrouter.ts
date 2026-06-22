import type { CachedModel } from "./types.js";

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  max_tokens?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
  };
}

export async function fetchOpenRouterModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }
  const payload = (await res.json()) as { data?: OpenRouterModel[] };
  return (payload.data ?? []).sort((a, b) => a.id.localeCompare(b.id));
}

export function openRouterModelToConfig(m: OpenRouterModel): any {
  return {
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"] as const,
    cost: {
      input: m.pricing?.prompt ?? 0,
      output: m.pricing?.completion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.context_length ?? 128000,
    maxTokens: m.max_tokens ?? 4096,
  };
}

export function openRouterModelToCached(m: OpenRouterModel): CachedModel {
  return {
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: {
      input: m.pricing?.prompt ?? 0,
      output: m.pricing?.completion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.context_length ?? 128000,
    maxTokens: m.max_tokens ?? 4096,
  };
}
