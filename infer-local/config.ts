/**
 * infer-local/config.ts — optional config + last-good snapshot cache.
 *
 * Config:  ~/.pi/agent/infer-local.json (missing file = defaults; everything is optional)
 * Cache:   ~/.pi/agent/infer-local-cache.json — last successful gateway snapshot, used
 *          when the gateway is down so a Pi restart still shows the local model row.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, type LiveSnapshot } from "./gateway.js";

export interface InferLocalConfig {
  /** OpenAI-compatible root of the gateway. Default http://127.0.0.1:8090/v1 */
  baseUrl: string;
  /** Provider id registered in Pi. Keep `infer` to reuse the models.json entry. */
  providerId: string;
  /** Provider label in `/mm` and the model selector. */
  name: string;
  /**
   * Gateway preset names exposed as extra providers (one per name), each pinned via the
   * `X-Infer-Preset` header: e.g. ["sub-agents-recon"] -> provider `infer-sub-agents-recon`.
   * Empty = only the bare live model.
   */
  presets: string[];
  /**
   * Gateway preset pinned on the BASE provider via `X-Infer-Preset`, so the single local
   * row always runs with that sampling (e.g. "agents" from the gateway's universal
   * layer). Empty = no header (plain passthrough). Applied only when the stored snapshot
   * lists the name for every chat alias; otherwise the row falls back to passthrough
   * (re-check from /mm → this provider → Refresh from gateway).
   */
  defaultPreset: string;
  /** Hard cap for the per-model max output tokens. Default 32768. */
  maxTokensCap?: number;
  /** Fallback context window when the gateway profile has no ctx_max. Default 65536. */
  contextWindowFallback?: number;
  /** Merged over the default compat (qwen-chat-template wire used by the local llama models). */
  compat?: Record<string, unknown>;
  /**
   * Pi thinking level -> `reasoning_effort` value for the local rows. Omit for the
   * Qwen-family default (`DEFAULT_THINKING_LEVEL_MAP` in gateway.ts), which is what the
   * local chat templates accept. Override only if a local family speaks another vocabulary.
   */
  thinkingLevelMap?: Record<string, string | null>;
}

export const DEFAULT_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: true,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  thinkingFormat: "qwen-chat-template",
};

export function defaultConfig(): InferLocalConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    providerId: "infer",
    name: "Infer local (live gateway)",
    presets: [],
    defaultPreset: "",
  };
}

/** Keep only string/null values; an empty map is the same as "not configured". */
function asThinkingLevelMap(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, mapped] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mapped === "string") out[key] = mapped;
    else if (mapped === null) out[key] = null;
  }
  return Object.keys(out).length ? out : undefined;
}

export function configPath(): string {
  return path.join(getAgentDir(), "infer-local.json");
}

export function cachePath(): string {
  return path.join(getAgentDir(), "infer-local-cache.json");
}

export function loadConfig(): InferLocalConfig {
  const base = defaultConfig();
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return base;
  }
  if (!raw || typeof raw !== "object") return base;
  return {
    baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : base.baseUrl,
    providerId: typeof raw.providerId === "string" && raw.providerId ? raw.providerId : base.providerId,
    name: typeof raw.name === "string" && raw.name ? raw.name : base.name,
    presets: Array.isArray(raw.presets) ? raw.presets.filter((p: unknown) => typeof p === "string" && p) : base.presets,
    defaultPreset: typeof raw.defaultPreset === "string" ? raw.defaultPreset.trim() : base.defaultPreset,
    maxTokensCap: typeof raw.maxTokensCap === "number" && raw.maxTokensCap > 0 ? raw.maxTokensCap : undefined,
    contextWindowFallback:
      typeof raw.contextWindowFallback === "number" && raw.contextWindowFallback > 0
        ? raw.contextWindowFallback
        : undefined,
    compat: raw.compat && typeof raw.compat === "object" && !Array.isArray(raw.compat) ? raw.compat : undefined,
    thinkingLevelMap: asThinkingLevelMap(raw.thinkingLevelMap),
  };
}

export function readCachedSnapshot(): LiveSnapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), "utf-8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.aliases)) return raw as LiveSnapshot;
  } catch {
    /* no cache yet */
  }
  return null;
}

export function writeCachedSnapshot(snapshot: LiveSnapshot): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(snapshot, null, 2), "utf-8");
  } catch {
    /* a cache write failure must never break a session */
  }
}
