import type { CachedModel } from "./types.js";
import { NANOGPT_BASE_URL, toPiInput } from "./wire-compat.js";

/**
 * NanoGPT model stub (GET /api/v1/models?detailed=true).
 * `pricing.prompt` / `pricing.completion` are USD per 1M tokens and
 * `cacheReadInputPer1kTokens` is per 1K. Pi `Model.cost` is per **1M** tokens
 * (see the shipped catalogs: gpt-4 = 30/60, kimi-k3 = 3/15) — so only the
 * cache figure needs rescaling.
 */
export interface NanoGptModel {
  id: string;
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  capabilities?: { vision?: boolean; reasoning?: boolean };
  reasoning_efforts?: unknown;
  open_weights?: boolean;
  pricing?: {
    prompt?: number;
    completion?: number;
    cacheReadInputPer1kTokens?: number;
  };
}

/**
 * Host note: `nano-gpt.com/api/v1` sits behind a Vercel bot checkpoint that
 * answers non-browser clients with 403 (HTML, not JSON). `api.nano-gpt.com`
 * serves the identical API without it — use that for programmatic calls.
 */
export async function fetchNanoGptModels(apiKey?: string): Promise<NanoGptModel[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${NANOGPT_BASE_URL}/models?detailed=true`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NanoGPT API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const payload = (await res.json()) as { data?: NanoGptModel[] };
  return (payload.data ?? []).sort((a, b) => a.id.localeCompare(b.id));
}

function perMillion(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** NanoGPT quotes cache reads per 1K tokens; Pi `cost` is per 1M. */
function perThousandToPerMillion(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value * 1_000 : 0;
}

export function nanoGptModelToCached(m: NanoGptModel): CachedModel {
  const input =
    toPiInput(m.architecture?.input_modalities) ??
    (m.capabilities?.vision === true ? ["text", "image"] : ["text"]);
  const reasoning = m.capabilities?.reasoning === true || m.reasoning_efforts !== undefined;

  return {
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions",
    reasoning,
    input,
    cost: {
      input: perMillion(m.pricing?.prompt),
      output: perMillion(m.pricing?.completion),
      cacheRead: perThousandToPerMillion(m.pricing?.cacheReadInputPer1kTokens),
      cacheWrite: 0,
    },
    contextWindow: m.context_length ?? 128000,
    maxTokens: m.max_output_tokens ?? 4096,
  };
}
