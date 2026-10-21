/**
 * On-demand model specs from models.dev.
 *
 * Deliberately manual: the payload is ~4.7 MB, so nothing here runs on session
 * start, on a model-selector refresh, or on any timer. The user triggers it from
 * the provider detail ("Update model specs"); the filtered result is written into
 * model-manager.json (ManagedProvider.overrides) and every later lookup is local.
 *
 * Why it exists: Pi's built-in catalog lags new models. When `getModel()` misses,
 * the curated fallback in opencode.ts invents `contextWindow: 128000` — a silent
 * lie for a 1M-context model. models.dev carries the real numbers, plus
 * modalities and the knowledge cutoff. (deepseek-v4.1-flash, the original
 * motivating case, is catalogued by Pi 1.0.1 at 1M/384k — re-check
 * `pi --list-models` before pulling specs by hand.)
 *
 * Cost too: a catalog miss also means `cost: 0`, so the footer/turn-log `$`
 * never appears. models.dev `cost.input`/`.output` are USD per 1M — the same
 * unit as Pi `Model.cost` (cross-check: kimi-k3 = 3/15 in both). Tiered prices
 * (`cost.tiers`, e.g. minimax-m3 past 512k) are ignored — only the base rate is
 * stored, matching what Pi can express. Already-pulled overrides without
 * `cost*` are healed at resolve time from `CATALOG_GAP_COST` in wire-compat.ts
 * (empty since 1.0.1 — add a row only for a model the catalog lacks), so a
 * re-pull is not required for `$` to appear; this pull still refreshes the
 * stored numbers.
 */

export interface ModelsDevSpec {
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  knowledge?: string;
  /** USD per 1M tokens; field names match ModelOverride so the pull can spread in. */
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
}

/**
 * Providers whose models.dev key equals the Pi provider id. Anything else would
 * need an id translation table, so it is left out until it is actually needed.
 */
export const MODELS_DEV_PROVIDERS = new Set(["opencode", "opencode-go", "openrouter"]);

const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
}

interface ModelsDevModel {
  knowledge?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: ModelsDevCost;
}

interface ModelsDevPayload {
  [providerId: string]: { models?: Record<string, ModelsDevModel> } | undefined;
}

/**
 * Pure: pull the specs we care about out of a models.dev payload.
 * Unknown providers, missing models and junk shapes all yield {}.
 */
export function pickModelsDevSpecs(
  payload: unknown,
  providerId: string,
  modelIds: string[],
): Record<string, ModelsDevSpec> {
  const models = (payload as ModelsDevPayload | undefined)?.[providerId]?.models;
  if (!models || typeof models !== "object") return {};

  const wanted = new Set(modelIds);
  const out: Record<string, ModelsDevSpec> = {};
  for (const [id, raw] of Object.entries(models)) {
    if (!wanted.has(id)) continue;
    const m = (raw ?? {}) as ModelsDevModel;
    const spec: ModelsDevSpec = {};

    const contextWindow = positiveNumber(m.limit?.context);
    if (contextWindow !== undefined) spec.contextWindow = contextWindow;
    const maxTokens = positiveNumber(m.limit?.output);
    // models.dev sometimes reports output == context (e.g. kimi-k2.7-code
    // 262144/262144) meaning "not separately specified", not a real cap. Storing
    // it would let sanitizeMaxTokens() shrink a correct catalog maxTokens, so the
    // same ≈context threshold applies here and the catalog value stands.
    if (maxTokens !== undefined && (contextWindow === undefined || maxTokens < contextWindow * 0.9)) {
      spec.maxTokens = maxTokens;
    }

    // Base rate only (no `cost.tiers`), USD per 1M — same unit as Pi Model.cost.
    const cost = (m.cost && typeof m.cost === "object" ? m.cost : {}) as ModelsDevCost;
    const costInput = positiveNumber(cost.input);
    if (costInput !== undefined) spec.costInput = costInput;
    const costOutput = positiveNumber(cost.output);
    if (costOutput !== undefined) spec.costOutput = costOutput;
    const costCacheRead = positiveNumber(cost.cache_read);
    if (costCacheRead !== undefined) spec.costCacheRead = costCacheRead;
    const costCacheWrite = positiveNumber(cost.cache_write);
    if (costCacheWrite !== undefined) spec.costCacheWrite = costCacheWrite;

    const inputModalities = stringList(m.modalities?.input);
    if (inputModalities) spec.inputModalities = inputModalities;
    const outputModalities = stringList(m.modalities?.output);
    if (outputModalities) spec.outputModalities = outputModalities;

    if (typeof m.knowledge === "string" && m.knowledge.trim()) {
      spec.knowledge = m.knowledge.trim();
    }

    if (Object.keys(spec).length > 0) out[id] = spec;
  }
  return out;
}

export async function fetchModelsDevSpecs(
  providerId: string,
  modelIds: string[],
): Promise<Record<string, ModelsDevSpec>> {
  const res = await fetch(MODELS_DEV_URL);
  if (!res.ok) {
    throw new Error(`models.dev API error ${res.status}`);
  }
  return pickModelsDevSpecs(await res.json(), providerId, modelIds);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return list.length > 0 ? list : undefined;
}
