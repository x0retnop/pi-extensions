import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import { getModel as getBuiltinModel } from "@earendil-works/pi-ai/compat";
import { parseNonNegativeInt, parsePositiveInt } from "./util.js";
import { getAvailableRoles } from "../role-sw/roles.js";

const SETTINGS_KEY = "subAgents";
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const MODEL_STORE_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models-store.json");
const MODEL_MANAGER_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "model-manager.json");

/** Per-agent overrides stored in settings.json. Win over frontmatter. */
export interface AgentOverrides {
  model?: string;
  /** Role name; "none" explicitly disables the role. undefined = inherit frontmatter/default. */
  role?: string;
  tools?: string[];
  /** Hard wall-clock ceiling for one attempt (ms). */
  timeoutMs?: number;
  /** Hard assistant-turn ceiling for one attempt. */
  maxTurns?: number;
  /** Soft deadline (ms). */
  deadlineMs?: number;
  /** No stdout for this long, no tool running (ms). */
  idleMs?: number;
  /** No stdout for this long while a tool runs (ms). */
  toolIdleMs?: number;
  /** Stop at this share of the child's context window (percent). */
  contextLimitPercent?: number;
  /** How many times a fired hard/turn cap is extended (+50% each) on recent progress. 0 = never extend. */
  maxExtensions?: number;
  /** A cap extends only if a turn completed within this window (ms). */
  extendGraceMs?: number;
}

export interface SubAgentsSettings {
  defaultCwd?: string;
  /** Role applied to agents that have no role in frontmatter and no per-agent override. */
  defaultRole?: string;
  historyRetentionDays?: number;
  debugLog?: boolean;
  agentOverrides?: Record<string, AgentOverrides>;
}

/** Drop leftover keys from the role-based rewrite and the retired TUI parallel/chain path. */
const LEGACY_SETTINGS_KEYS = [
  "defaultExtensionsPolicy",
  "defaultCustomExtensions",
  "agentExtensions",
  "parallelConcurrency",
  "lastAgent",
  "lastMode",
  "taskRenderMode",
] as const;

export function stripLegacySettings(settings: SubAgentsSettings): SubAgentsSettings {
  const cleaned = { ...settings } as Record<string, unknown>;
  for (const key of LEGACY_SETTINGS_KEYS) delete cleaned[key];
  return cleaned as SubAgentsSettings;
}

/** Custom tools that are not built into Pi and the extension that provides them.
 *  Used by the runner to auto-load the required extension when a tool is listed
 *  in `tools` but `includeExtensions` is not `true`.
 */
export const TOOL_EXTENSION_MAP: Record<string, string> = {
  pwsh: "pi-agent-run",
  py: "pi-agent-run",
};

export const TOOL_PRESETS: Record<string, string[]> = {
  // Native tool names. `find` and `ls` are shell CLIs run inside `bash`.
  "read-only": ["read", "grep", "bash"],
  // Read-only exploration + Windows-native/script tooling from pi-agent-run.
  "read-only-win": ["read", "grep", "bash", "pwsh", "py"],
  worker: ["read", "grep", "bash", "pwsh", "py", "edit", "write", "multi_edit"],
};

export function getSettings(): SubAgentsSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return stripLegacySettings((parsed[SETTINGS_KEY] as SubAgentsSettings) ?? {});
  } catch {
    return {};
  }
}

export async function saveSettings(settings: SubAgentsSettings): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    parsed = JSON.parse(raw);
  } catch {
    // start fresh
  }
  parsed[SETTINGS_KEY] = stripLegacySettings(settings);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2), "utf-8");
}

/**
 * Merge order: per-agent override > frontmatter > global defaultRole (role only).
 * Override role "none" explicitly disables role composition for the agent.
 */
export function resolveAgent(agent: AgentConfig, settings: SubAgentsSettings): AgentConfig {
  const ov = settings.agentOverrides?.[agent.name] ?? {};
  const role =
    ov.role !== undefined
      ? ov.role === "none" || ov.role.trim() === ""
        ? undefined
        : ov.role
      : agent.role ?? settings.defaultRole;
  return {
    ...agent,
    model: ov.model ?? agent.model,
    role,
    tools: ov.tools ?? agent.tools,
    timeoutMs: parsePositiveInt(ov.timeoutMs) ?? agent.timeoutMs,
    maxTurns: parsePositiveInt(ov.maxTurns) ?? agent.maxTurns,
    deadlineMs: parsePositiveInt(ov.deadlineMs) ?? agent.deadlineMs,
    idleMs: parsePositiveInt(ov.idleMs) ?? agent.idleMs,
    toolIdleMs: parsePositiveInt(ov.toolIdleMs) ?? agent.toolIdleMs,
    contextLimitPercent: parseNonNegativeInt(ov.contextLimitPercent) ?? agent.contextLimitPercent,
    maxExtensions: parseNonNegativeInt(ov.maxExtensions) ?? agent.maxExtensions,
    extendGraceMs: parsePositiveInt(ov.extendGraceMs) ?? agent.extendGraceMs,
  };
}

export function resolveAgents(agents: AgentConfig[], settings: SubAgentsSettings): AgentConfig[] {
  return agents.map((a) => resolveAgent(a, settings));
}

/** One-line summary of the effective agent config for TUI labels. */
export function formatEffective(agent: AgentConfig): string {
  const model = agent.model ?? "default-model";
  const role = agent.role ?? "no-role";
  const tools = agent.tools?.length ? agent.tools.join("+") : "default-tools";
  return `${model} · ${role} · ${tools}`;
}

/** Role names for the `/sub` picker — role family aliases, one per family (see role-sw/roles.ts). */
export function listAvailableRoles(): Promise<string[]> {
  return getAvailableRoles();
}

export interface ModelChoice {
  /** `provider/modelId` — stored in overrides and passed to `--model`. */
  id: string;
  /** TUI label. Differs from `id` when models.json has a display name (e.g. grok 4.6 f). */
  label: string;
}

interface FavoriteRef {
  providerId?: string;
  modelId?: string;
}

interface ManagedProviderRef {
  id?: string;
  lastUsedModel?: string;
}

/** Pinned `/mm` favorites only. Provider-only pins fall back to that provider's lastUsedModel. */
export function favoriteModelChoices(
  mm: { favorites?: FavoriteRef[]; providers?: ManagedProviderRef[] },
  displayNames: Record<string, string> = {},
): ModelChoice[] {
  const lastUsed = new Map<string, string>();
  for (const p of mm.providers ?? []) {
    if (p?.id && p.lastUsedModel) lastUsed.set(p.id, p.lastUsedModel);
  }
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const fav of mm.favorites ?? []) {
    if (!fav?.providerId) continue;
    const modelId = fav.modelId || lastUsed.get(fav.providerId);
    if (!modelId) continue;
    const id = `${fav.providerId}/${modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = displayNames[id]?.trim();
    const label = name && name !== modelId && name !== id ? `${id} · ${name}` : id;
    out.push({ id, label });
  }
  return out;
}

function modelDisplayNamesFromModelsJson(modelsJson: { providers?: Record<string, { models?: { id?: string; name?: string }[] }> }): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [providerId, provider] of Object.entries(modelsJson.providers ?? {})) {
    for (const m of provider.models ?? []) {
      if (m?.id && m.name) names[`${providerId}/${m.id}`] = m.name;
    }
  }
  return names;
}

/** Pinned favorites from model-manager.json. Empty if the file is missing. */
export function listFavoriteModels(): ModelChoice[] {
  let mm: { favorites?: FavoriteRef[]; providers?: ManagedProviderRef[] } = {};
  let names: Record<string, string> = {};
  try {
    mm = JSON.parse(fs.readFileSync(MODEL_MANAGER_JSON_PATH, "utf-8"));
  } catch {
    return [];
  }
  try {
    names = modelDisplayNamesFromModelsJson(JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf-8")));
  } catch {
    // names are optional; ids still work
  }
  return favoriteModelChoices(mm, names);
}

/** Ids only — same source as the TUI picker. */
export function listAvailableModels(): string[] {
  return listFavoriteModels().map((m) => m.id);
}

// ── Child context window ────────────────────────────────────────────
// The sub-agent guard stops a child that fills its context window (a large
// window is cheap to read and expensive to pay for). The window is not in the
// child's JSON stream, so it is resolved from the same catalogues the runtime
// uses, by the provider/model the child reports.

interface StoreProvider {
  models?: { id?: string; contextWindow?: number }[];
}

function windowFromProvidersJson(
  providers: Record<string, StoreProvider> | undefined,
  provider: string,
  modelId: string,
): number | undefined {
  const models = providers?.[provider]?.models;
  if (!Array.isArray(models)) return undefined;
  const match = models.find((m) => m?.id === modelId);
  const window = match?.contextWindow;
  return typeof window === "number" && window > 0 ? window : undefined;
}

function windowFromModelsJson(
  providers: Record<string, { models?: { id?: string; contextWindow?: number }[] }> | undefined,
  provider: string,
  modelId: string,
): number | undefined {
  const models = providers?.[provider]?.models;
  if (!Array.isArray(models)) return undefined;
  const match = models.find((m) => m?.id === modelId);
  const window = match?.contextWindow;
  return typeof window === "number" && window > 0 ? window : undefined;
}

/**
 * Context window for `provider/modelId`: the curated store first, the user's
 * models.json second, Pi's built-in catalogue last. Returns undefined when none
 * of the three knows the model — the runner then skips the context guard rather
 * than guessing.
 *
 * The built-in fallback is not optional in practice: models-store.json is a
 * pi.dev cache (frozen for as long as PI_OFFLINE is set) and models.json holds
 * host overrides only, so a stock model that the store's last fetch predates
 * (xai/grok-4.7 in 2026-10) would otherwise read as unknown while the runtime
 * itself runs and prices it fine.
 */
export function resolveModelContextWindow(provider: string, modelId: string): number | undefined {
  try {
    const store = JSON.parse(fs.readFileSync(MODEL_STORE_JSON_PATH, "utf-8"));
    const window = windowFromProvidersJson(store, provider, modelId);
    if (window) return window;
  } catch {
    // store missing or malformed — fall through to models.json
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf-8"));
    const window = windowFromModelsJson(parsed.providers, provider, modelId);
    if (window) return window;
  } catch {
    // models.json missing or malformed — fall through to the built-in catalogue
  }
  try {
    const builtin = getBuiltinModel(provider as any, modelId);
    const window = (builtin as { contextWindow?: number } | undefined)?.contextWindow;
    if (typeof window === "number" && window > 0) return window;
  } catch {
    // built-in catalogue unavailable — the model stays unknown
  }
  return undefined;
}
