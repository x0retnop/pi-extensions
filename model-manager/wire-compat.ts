/**
 * Wire-compat for curated openai-completions models.
 *
 * Principle: prefer Pi's catalog as-is. Only apply small, named profiles where
 * the catalog is known-wrong for a host (not a pile of global knobs).
 *
 * Known issues this covers:
 * 1) Multi-turn tool history: Kimi/DeepSeek need
 *    requiresReasoningContentOnAssistantMessages (Pi injects reasoning_content:"").
 * 2) OpenCode Go + Kimi: stock kimi-k2.7-code lacks the working k2.6 wire shape
 *    (thinkingFormat deepseek, no dual reasoning_effort, sane maxTokens).
 * 3) maxTokens ≈ contextWindow → first-request 400 when Pi sends max_tokens.
 * 4) Catalog newer-model gaps: a manual override (models.dev pull or hand-typed)
 *    wins over everything and is applied last.
 * 5) Catalog-gap cost: Pi `calculateCost` uses Model.cost / 1e6; a miss ships
 *    `cost: 0`, so the footer/turn-log `$` never appears (`if (t.cost > 0)`).
 *    models.dev pull stores cost* on the override, but already-pulled configs
 *    (and a curate without a pull) have none — fill known list prices when
 *    the resolved cost is still 0. A pull / catalog value still wins.
 *
 * Not covered on purpose: `prompt_cache_retention` / `prompt_cache_key`. Pi sends
 * them only under `PI_CACHE_RETENTION=long`, which this host does not set
 * (removed 2026-09-25 — no measured beneficiary, and Z.ai 400s on the field:
 * `docs/pi-provider-payloads.md` §3). If a strict upstream ever needs the knob
 * off again, add a named per-model compat profile here rather than a global rule.
 */

import type { ModelOverride } from "./types.js";

export type ModelFamily = "kimi" | "deepseek" | "reasoner" | "other";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * NanoGPT: the documented `nano-gpt.com/api/v1` is behind a Vercel bot
 * checkpoint that 403s programmatic clients; `api.nano-gpt.com` is the same
 * API without it (it is the host their own docs use for /batches).
 */
export const NANOGPT_BASE_URL = "https://api.nano-gpt.com/api/v1";

/** Working Moonshot-on-OpenCode profile (matches stock kimi-k2.6 on opencode-go). */
export const KIMI_OPENCODE_WIRE = {
  supportsStore: false,
  supportsDeveloperRole: false,
  thinkingFormat: "deepseek" as const,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens" as const,
  supportsLongCacheRetention: false,
  requiresReasoningContentOnAssistantMessages: true,
};

export const KIMI_OPENCODE_THINKING_MAP = {
  minimal: null,
  low: null,
  medium: null,
} as const;

export function detectModelFamily(id: string, name = ""): ModelFamily {
  const s = `${id} ${name}`.toLowerCase();
  if (s.includes("kimi") || s.includes("moonshot")) return "kimi";
  if (s.includes("deepseek")) return "deepseek";
  if (/(?:^|[-_/.])(r1|reasoner)(?:$|[-_/.])/.test(s) || s.includes("reasoner")) {
    return "reasoner";
  }
  return "other";
}

function defaultBaseUrl(providerId: string): string | undefined {
  if (providerId === "opencode-go") return OPENCODE_GO_BASE_URL;
  if (providerId === "opencode") return "https://opencode.ai/zen/v1";
  if (providerId === "openrouter") return OPENROUTER_BASE_URL;
  if (providerId === "nano-gpt") return NANOGPT_BASE_URL;
  return undefined;
}

function isOpenCodeHost(providerId: string, baseUrl?: string): boolean {
  if (providerId === "opencode-go" || providerId === "opencode") return true;
  const u = (baseUrl ?? "").toLowerCase();
  return u.includes("opencode.ai");
}

/**
 * Cap output tokens when the catalog sets maxTokens ≈ contextWindow.
 * Pi always sends max_tokens; input+max can then exceed the model limit.
 */
export function sanitizeMaxTokens(def: {
  maxTokens?: number;
  contextWindow?: number;
}): number | undefined {
  const max = def.maxTokens;
  const ctx = def.contextWindow;
  if (max === undefined || !Number.isFinite(max) || max <= 0) return max;
  if (ctx === undefined || !Number.isFinite(ctx) || ctx <= 0) return max;
  if (max >= ctx * 0.9) {
    return Math.min(max, Math.max(8192, Math.floor(ctx / 4)));
  }
  return max;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * List prices for models Pi's shipped catalog still lacks. USD per 1M — same
 * unit as `Model.cost`. Applied only when input and output are both still 0, so
 * a models.dev pull or a later catalog entry wins. `cacheWrite: 0` is required:
 * Pi's `calculateCost` does `rates.cacheWrite * n` and `undefined * 0` is NaN.
 *
 * Empty on purpose (2026-10-03): the only entry, `deepseek-v4.1-flash`, is now
 * shipped by Pi 1.0.1 (1M/384k, cost 0.15/0.6), so the heal never fired. Add
 * `"<model-id>": { input, output, cacheRead? }` here only for a model
 * `pi --list-models` does NOT show.
 */
const CATALOG_GAP_COST: Record<string, { input: number; output: number; cacheRead?: number }> = {};

function fillCatalogGapCost<T extends Record<string, any>>(def: T): T {
  const known = CATALOG_GAP_COST[String(def.id ?? "")];
  if (!known) return def;
  const prev = (def.cost && typeof def.cost === "object" ? def.cost : {}) as Record<string, unknown>;
  const hasInput = typeof prev.input === "number" && prev.input > 0;
  const hasOutput = typeof prev.output === "number" && prev.output > 0;
  if (hasInput || hasOutput) return def;
  return { ...def, cost: { cacheWrite: 0, ...prev, ...known } };
}

/** Keep only what Pi can send; drop junk so a bad config cannot widen input. */
function piInputList(value: unknown): ("text" | "image")[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is "text" | "image" => v === "text" || v === "image");
  return out.length > 0 ? out : undefined;
}

/**
 * Reduce models.dev `modalities.input` to the set Pi can actually send.
 * Cross-checked against Pi's own opencode-go catalog: this reproduces the catalog
 * for every model the catalog has (`deepseek-v4-flash` → text, `kimi-k3` /
 * `kimi-k2.7-code` / `minimax-m3` → text+image) and adds `image` only where the
 * catalog has no entry at all (`deepseek-v4.1-flash`). `video`/`pdf`/`audio` have
 * no Pi equivalent and stay display-only. Undefined when nothing usable is known,
 * so an existing value is never clobbered.
 */
export function toPiInput(modalities?: string[]): ("text" | "image")[] | undefined {
  if (!modalities) return undefined;
  const out: ("text" | "image")[] = [];
  if (modalities.includes("text")) out.push("text");
  if (modalities.includes("image")) out.push("image");
  return out.length > 0 ? out : undefined;
}

/**
 * Manual per-model truth (models.dev pull or hand-typed), applied last so it
 * outranks the catalog. Returns `def` untouched when there is no override.
 * Api-agnostic: real config fields only, never compat.
 */
function applyOverride<T extends Record<string, any>>(def: T, override?: ModelOverride): T {
  if (!override) return def;
  const next: Record<string, any> = { ...def };
  if (override.displayName) next.name = override.displayName;
  if (isPositive(override.contextWindow)) next.contextWindow = override.contextWindow;
  if (isPositive(override.maxTokens)) next.maxTokens = override.maxTokens;
  if (typeof override.reasoning === "boolean") next.reasoning = override.reasoning;
  // Older pulls stored only inputModalities; derive from it so those configs heal
  // without a re-pull.
  const input = piInputList(override.input) ?? toPiInput(override.inputModalities);
  if (input) next.input = input;
  const cost: Record<string, unknown> = {
    ...(next.cost && typeof next.cost === "object" ? next.cost : {}),
  };
  if (typeof override.costInput === "number") cost.input = override.costInput;
  if (typeof override.costOutput === "number") cost.output = override.costOutput;
  if (typeof override.costCacheRead === "number") cost.cacheRead = override.costCacheRead;
  if (typeof override.costCacheWrite === "number") cost.cacheWrite = override.costCacheWrite;
  if (Object.keys(cost).length > 0) next.cost = cost;
  return next as T;
}

/**
 * Normalize a curated model def before registerProvider().
 * Keep this function boring — named profiles only, no broad experimentation.
 */
export function patchCuratedModelDef<T extends Record<string, any>>(
  providerId: string,
  def: T,
  override?: ModelOverride,
): T {
  if (!def) return def;

  // Override first: api-agnostic, unlike the openai-completions profiles below.
  // Gap-cost fill is also api-agnostic (Pi calculateCost does not care).
  const overridden = fillCatalogGapCost(applyOverride(def, override));
  if (def.api && def.api !== "openai-completions") return overridden;

  const id = String(def.id ?? "");
  const name = String(def.name ?? "");
  const family = detectModelFamily(id, name);
  const onOpenCode = isOpenCodeHost(providerId, def.baseUrl);

  let next: Record<string, any> = { ...overridden };
  const compat: Record<string, unknown> = {
    ...(def.compat && typeof def.compat === "object" ? def.compat : {}),
  };

  // --- Profile: Kimi on OpenCode Go/Zen ---
  // Stock kimi-k2.7-code is incomplete vs working kimi-k2.6 on the same host.
  // Apply the known-good Moonshot-on-OpenCode wire in one place.
  if (family === "kimi" && onOpenCode) {
    Object.assign(compat, KIMI_OPENCODE_WIRE);
    if (!next.thinkingLevelMap) {
      next.thinkingLevelMap = { ...KIMI_OPENCODE_THINKING_MAP };
    }
  } else {
    // --- Everyone else: only fill catalog gaps ---
    // Multi-turn tools: DeepSeek/Kimi/reasoner need reasoning_content on assistant turns.
    if (family === "kimi" || family === "deepseek" || family === "reasoner") {
      compat.requiresReasoningContentOnAssistantMessages = true;
    }

    // Strict OpenAI proxies: max_tokens field + no store (only if unset).
    if (onOpenCode) {
      if (compat.supportsStore === undefined) compat.supportsStore = false;
      if (compat.supportsDeveloperRole === undefined) compat.supportsDeveloperRole = false;
      if (compat.maxTokensField === undefined) compat.maxTokensField = "max_tokens";
    } else if (providerId === "openrouter") {
      if (compat.supportsDeveloperRole === undefined) compat.supportsDeveloperRole = false;
    }
  }

  const baseUrl = next.baseUrl ?? defaultBaseUrl(providerId);
  const maxTokens = sanitizeMaxTokens(next);

  next = {
    ...next,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    compat,
  };

  return next as T;
}
