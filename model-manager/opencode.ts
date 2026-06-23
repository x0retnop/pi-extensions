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

export function opencodeModelToCached(m: OpencodeModel): CachedModel {
  return {
    id: m.id,
    name: m.id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}
