import type { CachedModel } from "./types.js";

export interface OpencodeModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export async function fetchOpencodeModels(apiKey?: string): Promise<OpencodeModel[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch("https://opencode.ai/zen/go/v1/models", { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenCode Go API error ${res.status}: ${text}`);
  }
  const payload = (await res.json()) as { data?: OpencodeModel[] };
  return (payload.data ?? []).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Bare stub from the OpenCode Go /models list.
 * Prefer enrichCachedModel() (uses Pi built-in catalog) before registering —
 * without compat.maxTokensField Pi sends max_completion_tokens and Go returns 400
 * for models like kimi-k2.7-code.
 */
export function opencodeModelToCached(m: OpencodeModel): CachedModel {
  return {
    id: m.id,
    name: m.id,
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  };
}
