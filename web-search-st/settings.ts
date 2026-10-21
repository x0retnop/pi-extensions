// webSearchSt block in ~/.pi/agent/settings.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SETTINGS_KEY = "webSearchSt";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export const PROVIDER_ORDER = ["exa", "brave", "tavily", "bing"] as const;
export type ProviderName = (typeof PROVIDER_ORDER)[number];

export interface WebSearchStSettings {
  /** Default for new sessions / branches with no custom entry. `/web on|off` writes this. */
  enabled: boolean;
  /** Fall through the chain on empty/error. Tool `fallback` overrides per call. */
  fallback: boolean;
  /** Provider order. Unknown names dropped; missing ones appended in default order. */
  chain: ProviderName[];
  /** Providers skipped entirely (not the same as "no key"). */
  disabled: ProviderName[];
  /** Last fetch hop: render in the user's live Chrome via C:/tools/agent-browser/fetch.py. */
  browserFallback: boolean;
  /** Saved Brave key. `BRAVE_API_KEY` env wins when set. */
  braveKey: string;
  /** Saved Tavily key. `TAVILY_API_KEY` env wins when set. */
  tavilyKey: string;
}

export const DEFAULTS: WebSearchStSettings = {
  enabled: false,
  fallback: true,
  chain: [...PROVIDER_ORDER],
  disabled: [],
  browserFallback: true,
  braveKey: "",
  tavilyKey: "",
};

export function loadSettingsFile(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

export function saveSettingsFile(settings: Record<string, unknown>): void {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {
    // ignore
  }
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function isProviderName(v: string): v is ProviderName {
  return (PROVIDER_ORDER as readonly string[]).includes(v);
}

export function providerEnabled(disabled: readonly string[] | undefined, name: ProviderName): boolean {
  return !normalizeDisabled([...(disabled ?? [])]).includes(name);
}

/** Keep known names, preserve given order, append any missing in default order. */
export function normalizeChain(chain?: string[]): ProviderName[] {
  const seen = new Set<ProviderName>();
  const out: ProviderName[] = [];
  for (const raw of [...(chain ?? []), ...PROVIDER_ORDER]) {
    const name = String(raw).trim().toLowerCase();
    if (!isProviderName(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function normalizeDisabled(disabled?: string[]): ProviderName[] {
  const out: ProviderName[] = [];
  const seen = new Set<ProviderName>();
  for (const raw of disabled ?? []) {
    const name = String(raw).trim().toLowerCase();
    if (!isProviderName(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function loadWebSearchSettings(rawFile?: Record<string, unknown>): WebSearchStSettings {
  const file = rawFile ?? loadSettingsFile();
  const raw = (file[SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {};
  return {
    enabled: asBool(raw.enabled, DEFAULTS.enabled),
    fallback: asBool(raw.fallback, DEFAULTS.fallback),
    chain: normalizeChain(Array.isArray(raw.chain) ? raw.chain.map(String) : undefined),
    disabled: normalizeDisabled(Array.isArray(raw.disabled) ? raw.disabled.map(String) : undefined),
    browserFallback: asBool(raw.browserFallback, DEFAULTS.browserFallback),
    braveKey: typeof raw.braveKey === "string" ? raw.braveKey.trim() : "",
    tavilyKey: typeof raw.tavilyKey === "string" ? raw.tavilyKey.trim() : "",
  };
}

export function saveWebSearchSettings(s: WebSearchStSettings): void {
  const file = loadSettingsFile();
  const block: Record<string, unknown> = {
    enabled: s.enabled,
    fallback: s.fallback,
    chain: normalizeChain(s.chain),
    disabled: normalizeDisabled(s.disabled),
    browserFallback: s.browserFallback,
  };
  if (s.braveKey) block.braveKey = s.braveKey;
  if (s.tavilyKey) block.tavilyKey = s.tavilyKey;
  file[SETTINGS_KEY] = block;
  saveSettingsFile(file);
}

export function resolveKey(envVal: string | undefined, saved: string): string {
  return envVal?.trim() || saved.trim();
}

export function keySource(envVal: string | undefined, saved: string): "env" | "saved" | "none" {
  if (envVal?.trim()) return "env";
  if (saved.trim()) return "saved";
  return "none";
}

export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "(empty)";
  if (k.length <= 4) return "****";
  return `****${k.slice(-4)}`;
}

export function moveProvider(chain: ProviderName[], name: ProviderName, dir: -1 | 1): ProviderName[] {
  const next = normalizeChain(chain);
  const i = next.indexOf(name);
  if (i < 0) return next;
  const j = i + dir;
  if (j < 0 || j >= next.length) return next;
  const copy = next.slice();
  const tmp = copy[i];
  copy[i] = copy[j];
  copy[j] = tmp;
  return copy;
}
