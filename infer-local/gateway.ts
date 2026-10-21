/**
 * infer-local/gateway.ts — live mirror of the local infer-gateway.
 *
 * Loopback-only fetch + pure mapping to Pi provider/model configs. No Pi runtime
 * imports, so the mapping is unit-testable (`tests/unit/infer-local.test.ts`).
 *
 * Non-obvious gateway facts this code depends on:
 *  - `model` in the request body MUST equal the gateway alias (resolve.py) — it is the
 *    route key, so a Pi model `id` cannot carry a preset suffix.
 *  - presets are selected by the `X-Infer-Preset` request header, i.e. per provider, not
 *    per model. One Pi provider per preset is therefore the only way to expose them.
 *  - `GET /v1/models` only carries id/kind; context + capabilities come from
 *    `GET /v1/profiles` (card-derived), preset names from `GET /v1/presets`.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Chat half of the `ProviderModelConfig` union — rows built here always carry `reasoning`. */
export type ChatRow = Extract<ProviderModelConfig, { reasoning: boolean }>;

export const DEFAULT_BASE_URL = "http://127.0.0.1:8090/v1";
export const DEFAULT_CONTEXT_WINDOW = 65536;
export const DEFAULT_MAX_TOKENS_CAP = 32768;
const MIN_MAX_TOKENS = 2048;
/** Default probe timeout — a stopped gateway must not delay Pi startup. */
const FETCH_TIMEOUT_MS = 2000;

/**
 * Pi thinking level -> the `reasoning_effort` value the model is given.
 *
 * Non-obvious: without this map Pi clamps its own thinking levels for a custom model
 * ("no evidence the model supports them"), so a session set to `xhigh`/`max` sends
 * `reasoning_effort: "high"` — and the Qwen3.x-family chat template that every local card
 * here uses raises HTTP 500 on anything outside {xhigh, medium, low}:
 *
 *   Jinja Exception: Unexpected reasoning effort high.
 *   Supported types are xhigh (default), medium, and low.
 *
 * The map fixes both halves at once:
 *  - the value sent (`high` -> `xhigh`, the model's real maximum);
 *  - `getSupportedThinkingLevels()`, which offers `xhigh`/`max` only when the map defines them.
 *
 * `off` is deliberately absent: absent means `undefined` (not `null`), so the level stays
 * selectable, and with thinking off Pi sends no `reasoning_effort` at all.
 */
export const DEFAULT_THINKING_LEVEL_MAP: Record<string, string | null> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "xhigh",
  xhigh: "xhigh",
  max: "xhigh",
};

export interface AliasCapabilities {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  json?: boolean;
  streaming?: boolean;
}

export interface LiveAlias {
  alias: string;
  /** Backend kind: "chat" | "embeddings". Anything but "chat" is ignored. */
  kind: string;
  ctxMax?: number;
  capabilities?: AliasCapabilities;
  description?: string;
}

export interface LiveSnapshot {
  baseUrl: string;
  fetchedAt: string;
  aliases: LiveAlias[];
  /** alias -> preset names (card presets + local overlay). */
  presets: Record<string, string[]>;
}

export interface RowOptions {
  /** Preset suffix for the display name; the request header is provider-level. */
  preset?: string | null;
  contextWindowFallback?: number;
  maxTokensCap?: number;
  /** Pi thinking level -> `reasoning_effort`; defaults to DEFAULT_THINKING_LEVEL_MAP. */
  thinkingLevelMap?: Record<string, string | null>;
}

/** True when every live chat alias publishes `name` (one provider header serves them all). */
export function presetPublished(snapshot: LiveSnapshot | null, name: string | null | undefined): boolean {
  if (!snapshot || !name) return false;
  const aliases = chatAliases(snapshot);
  if (aliases.length === 0) return false;
  return aliases.every((alias) => (snapshot.presets?.[alias.alias] ?? []).includes(String(name)));
}

function asObject(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

/** Gateway rejects `input + max_tokens > ctx_max`, so keep output within a quarter of ctx. */
export function maxTokensFor(contextWindow: number, cap = DEFAULT_MAX_TOKENS_CAP): number {
  const quarter = Math.floor(contextWindow / 4);
  return Math.max(MIN_MAX_TOKENS, Math.min(cap, quarter));
}

export function chatAliases(snapshot: LiveSnapshot): LiveAlias[] {
  return snapshot.aliases.filter((a) => a.kind === "chat");
}

/** Provider id for a preset variant: `infer` + `sub-agents-recon` -> `infer-sub-agents-recon`. */
export function presetProviderId(providerId: string, preset: string): string {
  const slug = preset
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${providerId}-${slug}` : providerId;
}

export function presetDisplayName(baseName: string, preset: string): string {
  return `${baseName} · ${preset}`;
}

/**
 * One Pi model row per live chat alias. `id` is the exact alias (the gateway route key);
 * the preset only changes the display name — selection is the `X-Infer-Preset` header.
 */
export function aliasToRow(alias: LiveAlias, opts: RowOptions = {}): ChatRow {
  const contextWindow =
    typeof alias.ctxMax === "number" && alias.ctxMax > 0
      ? alias.ctxMax
      : (opts.contextWindowFallback ?? DEFAULT_CONTEXT_WINDOW);
  const caps = alias.capabilities ?? {};
  const preset = opts.preset ? String(opts.preset) : null;
  return {
    id: alias.alias,
    name: preset ? `${alias.alias} · ${preset}` : alias.alias,
    // Pi gates image sending on this field only — never advertise vision from another source.
    input: caps.vision ? ["text", "image"] : ["text"],
    reasoning: caps.reasoning ?? true,
    // Keeps Pi's thinking levels inside the vocabulary the local chat templates accept.
    thinkingLevelMap: opts.thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAP,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxTokensFor(contextWindow, opts.maxTokensCap),
  };
}

export function rowsForSnapshot(snapshot: LiveSnapshot, opts: RowOptions = {}): ChatRow[] {
  return chatAliases(snapshot).map((alias) => aliasToRow(alias, opts));
}

export function presetNamesFor(snapshot: LiveSnapshot, alias?: string): string[] {
  const names = new Set<string>();
  for (const [key, list] of Object.entries(snapshot.presets ?? {})) {
    if (alias && key !== alias) continue;
    for (const name of list ?? []) names.add(String(name));
  }
  return [...names].sort();
}

export function describeSnapshot(snapshot: LiveSnapshot): string {
  const aliases = chatAliases(snapshot).map((a) => `${a.alias} (${a.ctxMax ?? "?"} ctx)`);
  return aliases.length ? aliases.join(", ") : "no chat alias bound";
}

export function parseSnapshot(
  baseUrl: string,
  modelsPayload: unknown,
  profilesPayload?: unknown,
  presetsPayload?: unknown,
): LiveSnapshot {
  const models = asObject(modelsPayload)?.["data"];
  if (!Array.isArray(models)) {
    throw new Error("infer-gateway: /v1/models returned no model list");
  }
  const profiles = new Map<string, Record<string, any>>();
  for (const entry of (asObject(profilesPayload)?.["data"] as any[]) ?? []) {
    const profile = asObject(entry);
    if (profile && typeof profile["alias"] === "string") profiles.set(profile["alias"], profile);
  }
  const presets: Record<string, string[]> = {};
  for (const entry of (asObject(presetsPayload)?.["data"] as any[]) ?? []) {
    const preset = asObject(entry);
    const alias = preset?.["alias"];
    const name = preset?.["name"];
    if (typeof alias !== "string" || typeof name !== "string") continue;
    (presets[alias] ??= []).push(name);
  }

  const aliases: LiveAlias[] = [];
  for (const entry of models) {
    const model = asObject(entry);
    const id = model?.["id"];
    if (typeof id !== "string" || !id) continue;
    const profile = profiles.get(id) ?? {};
    aliases.push({
      alias: id,
      kind: typeof profile["kind"] === "string" ? profile["kind"] : typeof model?.["kind"] === "string" ? model["kind"] : "chat",
      ctxMax: typeof profile["ctx_max"] === "number" ? profile["ctx_max"] : undefined,
      capabilities: asObject(profile["capabilities"]) as AliasCapabilities | undefined,
      description: typeof profile["description"] === "string" ? profile["description"] : undefined,
    });
  }
  for (const [alias, names] of Object.entries(presets)) presets[alias] = [...new Set(names)].sort();

  return { baseUrl, fetchedAt: new Date().toISOString(), aliases, presets };
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return await response.json();
}

/**
 * Probe the gateway. `/v1/models` is required; profiles/presets are optional enrichment
 * (an older gateway build must not break the model list).
 */
export async function fetchSnapshot(baseUrl = DEFAULT_BASE_URL, timeoutMs = FETCH_TIMEOUT_MS): Promise<LiveSnapshot> {
  const base = String(baseUrl).replace(/\/+$/, "");
  const [models, profiles, presets] = await Promise.all([
    getJson(`${base}/models`, timeoutMs),
    getJson(`${base}/profiles`, timeoutMs).catch(() => null),
    getJson(`${base}/presets`, timeoutMs).catch(() => null),
  ]);
  return parseSnapshot(base, models, profiles, presets);
}
