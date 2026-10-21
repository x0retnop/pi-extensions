import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { UsagePinnedWindow, UsageProviderConfig } from "./types.js";
import { loadUsageConfig, saveUsageConfig } from "./config.js";

const USAGE_SNAPSHOT_FILE = "model-manager-usage-snapshot.json";
const USAGE_HISTORY_FILE = "model-manager-usage-history.json";
/** Manual-refresh calibration points (quota windows ↔ session tokens). JSONL. */
const USAGE_CALIB_FILE = "model-manager-usage-calib.jsonl";
/** Backstop after age / singleton / per-provider caps. */
const CALIB_MAX_LINES = 80;
const CALIB_MAX_PER_PROVIDER = 40;
const CALIB_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Unpaired /usage (one line, that session never came back) — dead weight. */
const CALIB_SINGLETON_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Rolling fetch history for today / week / since-last deltas. */
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_ENTRIES = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
/** Weekly-limit window label used by both Kimi and xAI parsers. */
export const WEEKLY_LIMIT_LABEL = "Weekly limit";
const MONTHLY_LIMIT_LABEL = "Monthly limit";

const KIMI_USAGE_PATTERNS = [
  "api.kimi.com/coding",
];

/**
 * Official Kimi Open Platform API rates (USD per 1M tokens) — fallback for
 * models on an `api.kimi.com/coding` endpoint whose registry entry lacks a
 * `cost` (e.g. `kimi-for-coding`, `kimi-k2-thinking`). Registry `cost` always
 * wins. Sources: platform.kimi.ai/docs/pricing/chat — k3 $3 / $0.3 cache /
 * $15 out; kimi-k2.7-code (= `kimi-for-coding`) $0.95 / $0.19 / $4;
 * highspeed $1.9 / $0.38 / $8.
 */
const KIMI_MODEL_COSTS: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "k3": { input: 3, output: 15, cacheRead: 0.3 },
  "k3-256k": { input: 3, output: 15, cacheRead: 0.3 },
  "kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19 },
  "kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38 },
  "kimi-k2-thinking": { input: 0.95, output: 4, cacheRead: 0.19 },
};

function isKimiEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const base = baseUrl.toLowerCase();
  return KIMI_USAGE_PATTERNS.some((p) => base.includes(p));
}

const OPENCODE_USAGE_PATTERNS = [
  "opencode.ai/zen/go",
];

/**
 * Official OpenCode Go monthly $ limits per model (docs/go "Usage limits",
 * fetched 2026-09-25; "limits may change" — table is a fallback seed, calib
 * pairs override once established). Windows are shares of the monthly limit:
 * rolling 5h = 20%, weekly = 50%, monthly = 100%. `space-bunny-free` is
 * unlimited and intentionally absent (no $ estimate).
 */
const OPENCODE_GO_MONTHLY_LIMITS: Record<string, number> = {
  "glm-5.3-flash": 60,
  "glm-5.3": 15,
  "glm-5.2": 60,
  "glm-5.1": 60,
  "kimi-k3": 15,
  "kimi-k2.7-code": 60,
  "kimi-k2.6": 60,
  "longcat-2.0": 60,
  "mimo-v2.6-flash": 60,
  "mimo-v2.6-pro": 15,
  "mimo-v2.5": 60,
  "mimo-v2.5-pro": 15,
  "minimax-m3": 60,
  "minimax-m2.7": 60,
  "minimax-m2.5": 60,
  "muse-spark-1.3-contributor": 60,
  "muse-spark-1.2-contributor": 60,
  "qwen3.8-max": 15,
  "qwen3.8-flash": 30,
  "qwen3.7-max": 30,
  "qwen3.7-plus": 60,
  "qwen3.6-plus": 60,
  "deepseek-v4.1-flash": 60,
  "deepseek-v4-pro": 15,
  "deepseek-v4-flash": 30,
  "deepseek-v4-flash-vision-exp": 15,
  "hy4-preview": 30,
  "hy3": 60,
  "grok-4.7": 15,
  "grok-4.6": 15,
  "gpt-6-luna": 15,
  "gpt-5.6-luna": 15,
};

/** Window label for the rolling 5h OpenCode Go window. */
export const ROLLING_5H_LIMIT_LABEL = "Rolling 5h limit";

/** Unofficial Grok subscription billing proxy (same surface as Grok CLI / pi-xai). */
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
/** Match built-in `xai` and any custom provider pointed at xAI / Grok CLI proxy. */
const XAI_USAGE_PATTERNS = [
  "api.x.ai",
  "cli-chat-proxy.grok.com",
];
/** CLI client headers expected by cli-chat-proxy (Bearer alone often works; keep parity with Grok CLI). */
const GROK_CLI_VERSION = "0.2.101";

export interface UsageWindow {
  label: string;
  used: number;
  limit: number;
  remaining: number;
  resetHint?: string;
}

export interface ProviderUsage {
  providerId: string;
  displayName: string;
  fetchedAt: string;
  error?: string;
  /** Whether this row came from a live API call or from the saved snapshot. */
  source?: "live" | "snapshot";
  /** Raw JSON payload from the provider, kept for debugging/inspect. */
  rawResponse?: unknown;
  windows: UsageWindow[];
}

export interface UsageWindowSnapshotEntry {
  providerId: string;
  displayName: string;
  fetchedAt: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  resetHint?: string;
}

export interface FetchUsageOptions {
  timeoutMs?: number;
}

function getSnapshotPath(): string {
  return path.join(getAgentDir(), USAGE_SNAPSHOT_FILE);
}

export function loadUsageSnapshot(): UsageWindowSnapshotEntry[] {
  const snapshotPath = getSnapshotPath();
  if (!fs.existsSync(snapshotPath)) return [];
  try {
    const raw = fs.readFileSync(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return Array.isArray(parsed.entries)
      ? parsed.entries
          .map((e: unknown) => normalizeSnapshotEntry(e))
          .filter((e): e is UsageWindowSnapshotEntry => e !== undefined)
      : [];
  } catch (err) {
    console.error(`[model-manager] Failed to load usage snapshot: ${err}`);
    return [];
  }
}

export function saveUsageSnapshot(entries: UsageWindowSnapshotEntry[]): void {
  const snapshotPath = getSnapshotPath();
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({ entries }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[model-manager] Failed to save usage snapshot: ${err}`);
  }
}

export function loadPinnedWindow(): UsagePinnedWindow | undefined {
  return loadUsageConfig().pinnedWindow;
}

export function savePinnedWindow(pinned: UsagePinnedWindow | undefined): void {
  const cfg = loadUsageConfig();
  cfg.pinnedWindow = pinned;
  saveUsageConfig(cfg);
}

function normalizeSnapshotEntry(raw: unknown): UsageWindowSnapshotEntry | undefined {
  const e = raw as Partial<UsageWindowSnapshotEntry> | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
  const used = toInt(e.used);
  const limit = toInt(e.limit);
  const remaining = toInt(e.remaining);
  if (used === undefined || limit === undefined || remaining === undefined) return undefined;
  return {
    providerId: String(e.providerId ?? ""),
    displayName: String(e.displayName ?? e.providerId ?? ""),
    fetchedAt: String(e.fetchedAt ?? new Date().toISOString()),
    label: String(e.label ?? ""),
    used,
    limit,
    remaining,
    resetHint: e.resetHint ? String(e.resetHint) : undefined,
  };
}

export function flattenSnapshot(providerUsages: ProviderUsage[]): UsageWindowSnapshotEntry[] {
  const entries: UsageWindowSnapshotEntry[] = [];
  for (const pu of providerUsages) {
    if (pu.error || pu.windows.length === 0) continue;
    for (const w of pu.windows) {
      entries.push({
        providerId: pu.providerId,
        displayName: pu.displayName,
        fetchedAt: pu.fetchedAt,
        label: w.label,
        used: w.used,
        limit: w.limit,
        remaining: w.remaining,
        resetHint: w.resetHint,
      });
    }
  }
  return entries;
}

export function getUsageProviders(ctx: ExtensionContext | ExtensionCommandContext): UsageProviderConfig[] {
  const manual = loadUsageConfig().providers;
  const auto = [
    ...detectKimiUsageProviders(ctx),
    ...detectOpencodeUsageProviders(ctx),
    ...detectXaiUsageProviders(ctx),
  ];
  const seen = new Set<string>();
  const merged: UsageProviderConfig[] = [];
  // Manual config wins over auto-detection so an explicit override can fix
  // a mis-detected endpoint without editing the registry.
  for (const p of [...manual, ...auto]) {
    if (seen.has(p.providerId)) continue;
    seen.add(p.providerId);
    merged.push(p);
  }
  return merged;
}

export function getUsageProvider(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): UsageProviderConfig | undefined {
  return getUsageProviders(ctx).find((p) => p.providerId === providerId);
}

export async function hasApiKeyForProvider(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): Promise<boolean> {
  const key = await ctx.modelRegistry.getApiKeyForProvider(providerId);
  return Boolean(key);
}

function detectKimiUsageProviders(ctx: ExtensionContext | ExtensionCommandContext): UsageProviderConfig[] {
  const providers = new Map<string, string>();
  for (const model of ctx.modelRegistry.getAll()) {
    if (!model.baseUrl) continue;
    const base = model.baseUrl.toLowerCase();
    if (KIMI_USAGE_PATTERNS.some((p) => base.includes(p))) {
      // baseUrl may or may not end with /v1 (openai-completions vs
      // anthropic-messages variants) — normalize before appending.
      const root = model.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
      providers.set(model.provider, root + "/v1/usages");
    }
  }
  return Array.from(providers.entries()).map(([providerId, usageUrl]) => ({ providerId, usageUrl }));
}

function detectOpencodeUsageProviders(ctx: ExtensionContext | ExtensionCommandContext): UsageProviderConfig[] {
  const providers = new Map<string, string>();
  for (const model of ctx.modelRegistry.getAll()) {
    if (!model.baseUrl) continue;
    const base = model.baseUrl.toLowerCase();
    if (OPENCODE_USAGE_PATTERNS.some((p) => base.includes(p))) {
      // OpenCode Go models live under /zen/go/v1 or /zen/go (anthropic-messages).
      // Normalize trailing slashes and the optional /v1 suffix before appending /v1/usage.
      const root = model.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
      providers.set(model.provider, root + "/v1/usage");
    }
  }
  return Array.from(providers.entries()).map(([providerId, usageUrl]) => ({ providerId, usageUrl }));
}

/**
 * xAI / Grok subscription quota lives on cli-chat-proxy, not on api.x.ai.
 * Detect built-in `xai` and any custom provider whose models hit xAI or the Grok CLI proxy.
 * Billing URL is always the subscription proxy (model baseUrl is usually api.x.ai).
 */
function detectXaiUsageProviders(ctx: ExtensionContext | ExtensionCommandContext): UsageProviderConfig[] {
  const providers = new Set<string>();
  for (const model of ctx.modelRegistry.getAll()) {
    const provider = String(model.provider ?? "");
    if (!provider) continue;
    if (provider.toLowerCase() === "xai") {
      providers.add(provider);
      continue;
    }
    const base = (model.baseUrl ?? "").toLowerCase();
    if (base && XAI_USAGE_PATTERNS.some((p) => base.includes(p))) {
      providers.add(provider);
    }
  }
  return Array.from(providers).map((providerId) => ({
    providerId,
    usageUrl: XAI_BILLING_URL,
  }));
}

function isXaiBillingUrl(usageUrl: string): boolean {
  const u = usageUrl.toLowerCase();
  return u.includes("cli-chat-proxy.grok.com") && u.includes("/billing");
}

export async function fetchProviderUsage(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
  usageUrl: string,
  options: FetchUsageOptions = {},
): Promise<ProviderUsage> {
  const displayName = ctx.modelRegistry.getProviderDisplayName(providerId) || providerId;
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
  if (!apiKey) {
    return {
      providerId,
      displayName,
      fetchedAt: new Date().toISOString(),
      error: "No API key configured",
      source: "live",
      windows: [],
    };
  }

  // Grok subscription: dual GET on cli-chat-proxy (monthly + weekly credits).
  // Not the Kimi-style single /usages endpoint — branch before the generic fetch.
  if (isXaiBillingUrl(usageUrl)) {
    const usage = await fetchXaiBillingUsage(providerId, displayName, apiKey, options);
    // Manual /usage refresh only (this path is never on a timer) — experiment log.
    if (!usage.error && usage.windows.length > 0) {
      appendUsageCalibPoint(ctx, usage);
    }
    return usage;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);

  try {
    const res = await fetch(usageUrl, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        providerId,
        displayName,
        fetchedAt: new Date().toISOString(),
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
        source: "live",
        windows: [],
      };
    }
    const payload = (await res.json()) as KimiUsagePayload;
    const opencode = parseOpencodeGoPayload(payload);
    const usage: ProviderUsage = {
      providerId,
      displayName,
      fetchedAt: new Date().toISOString(),
      source: "live",
      rawResponse: payload,
      windows: opencode ?? parseUsagePayload(payload),
    };
    // Kimi quota is a weighted unit (per Kimi docs: k3 consumes ~2× the quota
    // of k3-256k; HighSpeed ~3×) — neither tokens nor 1:1 requests. Pair the
    // windows with session token totals so Δquota can later be converted to $
    // (calib file → $/unit). OpenCode Go skips this: its meter is dollar-
    // defined by the public table, there is nothing to calibrate. Manual
    // /usage refresh only.
    if (usage.windows.length > 0 && opencode === undefined) appendUsageCalibPoint(ctx, usage);
    return usage;
  } catch (err) {
    return {
      providerId,
      displayName,
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      source: "live",
      windows: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Grok Build / SuperGrok subscription quotas via unofficial cli-chat-proxy billing.
 * - Monthly: GET /v1/billing — often disabled on current plans (`monthlyLimit=0`);
 *   omitted from windows when inactive (native Grok UI is weekly-only too).
 * - Weekly: GET /v1/billing?format=credits — primary meter (`creditUsagePercent`).
 * Needs subscription OAuth (Pi `/login xai`); plain XAI_API_KEY usually 401s here.
 */
async function fetchXaiBillingUsage(
  providerId: string,
  displayName: string,
  accessToken: string,
  options: FetchUsageOptions = {},
): Promise<ProviderUsage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  const headers = xaiBillingHeaders(accessToken);

  try {
    // Weekly is the live meter on current Grok Build / unified plans. Monthly is
    // best-effort and frequently all-zeros (limit 0) — do not hard-fail on it.
    let monthlyPayload: unknown;
    let weeklyPayload: unknown;
    let monthly: UsageWindow | undefined;
    let weekly: UsageWindow | undefined;
    let authError: string | undefined;

    const weeklyRes = await fetch(`${XAI_BILLING_URL}?format=credits`, {
      signal: controller.signal,
      headers,
      redirect: "manual",
    });
    if (weeklyRes.ok) {
      weeklyPayload = await weeklyRes.json();
      weekly = parseXaiWeeklyUsage(weeklyPayload);
    } else if (weeklyRes.status === 401 || weeklyRes.status === 403) {
      const text = await weeklyRes.text().catch(() => "");
      authError =
        `HTTP ${weeklyRes.status}: Grok billing needs subscription OAuth (/login xai)` +
        (text ? ` (${text.slice(0, 120)})` : "");
    }

    try {
      const monthlyRes = await fetch(XAI_BILLING_URL, {
        signal: controller.signal,
        headers,
        redirect: "manual",
      });
      if (monthlyRes.ok) {
        monthlyPayload = await monthlyRes.json();
        monthly = parseXaiMonthlyUsage(monthlyPayload);
      } else if (!authError && (monthlyRes.status === 401 || monthlyRes.status === 403)) {
        authError = `HTTP ${monthlyRes.status}: Grok billing needs subscription OAuth (/login xai)`;
      }
    } catch {
      // monthly optional
    }

    const windows: UsageWindow[] = [];
    if (monthly) windows.push(monthly);
    if (weekly) windows.push(weekly);

    if (windows.length === 0) {
      return {
        providerId,
        displayName,
        fetchedAt: new Date().toISOString(),
        error: authError ?? "No active xAI billing windows (monthly disabled, weekly unavailable)",
        source: "live",
        rawResponse: { monthly: monthlyPayload, weekly: weeklyPayload },
        windows: [],
      };
    }

    return {
      providerId,
      displayName,
      fetchedAt: new Date().toISOString(),
      source: "live",
      rawResponse: { monthly: monthlyPayload, weekly: weeklyPayload },
      windows,
    };
  } catch (err) {
    return {
      providerId,
      displayName,
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      source: "live",
      windows: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function xaiBillingHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "interactive",
    accept: "application/json",
  };
}

/** xAI money fields arrive as bare numbers or `{ val: number }`. */
function moneyishVal(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "number") {
    const n = (v as { val: number }).val;
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseXaiMonthlyUsage(payload: unknown): UsageWindow | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const config = (payload as { config?: unknown }).config;
  if (!config || typeof config !== "object") return undefined;
  const c = config as Record<string, unknown>;
  const limit = moneyishVal(c.monthlyLimit);
  const used = moneyishVal(c.used);
  if (limit === undefined || used === undefined) return undefined;
  // Current Grok Build / unified-billing plans report monthlyLimit=0 and used=0
  // (native UI is weekly-only). Treat limit<=0 as "monthly not active" — omit.
  if (limit <= 0) return undefined;
  const remaining = Math.max(0, limit - used);
  const end = typeof c.billingPeriodEnd === "string" ? c.billingPeriodEnd : undefined;
  return {
    label: "Monthly limit",
    used,
    limit,
    remaining,
    resetHint: end ? formatResetTime(end) : undefined,
  };
}

/**
 * Weekly credits endpoint reports percent used (0–100), not absolute credits.
 * Map onto a 100-unit window so the existing bar / delta UI stays unchanged.
 */
function parseXaiWeeklyUsage(payload: unknown): UsageWindow | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const config = (payload as { config?: unknown }).config;
  if (!config || typeof config !== "object") return undefined;
  const c = config as Record<string, unknown>;
  const currentPeriod = c.currentPeriod as Record<string, unknown> | undefined;
  if (currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return undefined;
  const pct = moneyishVal(c.creditUsagePercent);
  if (pct === undefined) return undefined;
  const used = Math.max(0, Math.min(100, pct));
  const end =
    (typeof currentPeriod.end === "string" && currentPeriod.end) ||
    (typeof c.billingPeriodEnd === "string" ? c.billingPeriodEnd : undefined);
  return {
    label: "Weekly limit",
    used,
    limit: 100,
    remaining: Math.max(0, 100 - used),
    resetHint: end ? formatResetTime(end) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Calibration log — manual /usage refresh only (no timers / no turn hooks).
// File: ~/.pi/agent/model-manager-usage-calib.jsonl
// Compact points (no derived `d`). Formula re-pairs in memory. Auto-prunes:
// 14d, unpaired sessions after 3d, 40/provider, 80 backstop.
// ---------------------------------------------------------------------------

interface SessionProviderTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  apiCost: number;
  turns: number;
}

interface UsageCalibPoint {
  at: string;
  providerId: string;
  /** Window used values at this point (label → used), e.g. `{"Weekly limit": 83}`. */
  windows?: Record<string, number>;
  /** xAI billing compat (monthly limit dollars, weekly credit percent). */
  monthlyUsed?: number;
  monthlyLimit?: number;
  weeklyPct?: number;
  sessionId?: string;
  model?: string;
  sess: SessionProviderTotals;
  /** Same as `sess` but only the active model — omitted on disk when equal. */
  sessModel?: SessionProviderTotals;
  /** Legacy derived deltas — no longer written; ignored if present. */
  d?: unknown;
}

function getCalibPath(): string {
  return path.join(getAgentDir(), USAGE_CALIB_FILE);
}

function messageModelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "id" in model) {
    return String((model as { id?: unknown }).id ?? "");
  }
  return "";
}

function sumSessionUsageForProvider(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
  modelId?: string,
): SessionProviderTotals {
  const t: SessionProviderTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    apiCost: 0,
    turns: 0,
  };
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      const e = entry as {
        type?: string;
        message?: {
          role?: string;
          provider?: string;
          model?: unknown;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            cost?: { total?: number };
          };
        };
      };
      if (e.type !== "message" || e.message?.role !== "assistant") continue;
      if (String(e.message.provider ?? "") !== providerId) continue;
      if (modelId !== undefined && messageModelId(e.message.model) !== modelId) continue;
      const u = e.message.usage;
      if (!u) continue;
      t.input += u.input ?? 0;
      t.output += u.output ?? 0;
      t.cacheRead += u.cacheRead ?? 0;
      t.cacheWrite += u.cacheWrite ?? 0;
      t.apiCost += u.cost?.total ?? 0;
      t.turns += 1;
    }
  } catch {
    // leave zeros
  }
  return t;
}

function sessTotalsEqual(a?: SessionProviderTotals, b?: SessionProviderTotals): boolean {
  if (!a || !b) return a === b;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.apiCost === b.apiCost &&
    a.turns === b.turns
  );
}

function compactCalibPoint(p: UsageCalibPoint): UsageCalibPoint {
  const out: UsageCalibPoint = {
    at: p.at,
    providerId: p.providerId,
    sess: p.sess,
  };
  if (p.windows) out.windows = p.windows;
  if (p.sessionId) out.sessionId = p.sessionId;
  if (p.model) out.model = p.model;
  if (p.sessModel && !sessTotalsEqual(p.sessModel, p.sess)) out.sessModel = p.sessModel;
  if ((p.monthlyLimit ?? 0) > 0) out.monthlyLimit = p.monthlyLimit;
  return out;
}

/**
 * Keep what the overlay can still use: recent enough to pair, or already a
 * same-session group. Strips derived `d` / duplicate fields. Not a forensics dump.
 */
export function selectCalibPointsToKeep(points: UsageCalibPoint[], nowMs = Date.now()): UsageCalibPoint[] {
  const cutoff = nowMs - CALIB_MAX_AGE_MS;
  const singletonCutoff = nowMs - CALIB_SINGLETON_MAX_AGE_MS;
  const fresh: UsageCalibPoint[] = [];
  for (const p of points) {
    if (!p?.providerId || !p.sess || !p.at || !p.sessionId) continue;
    const t = Date.parse(p.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    fresh.push(compactCalibPoint(p));
  }
  const groups = new Map<string, UsageCalibPoint[]>();
  for (const p of fresh) {
    const key = `${p.providerId}\0${p.sessionId}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const kept: UsageCalibPoint[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const last = Date.parse(list[list.length - 1].at);
    if (list.length < 2 && last < singletonCutoff) continue;
    kept.push(...list);
  }
  const byProvider = new Map<string, UsageCalibPoint[]>();
  for (const p of kept) {
    const list = byProvider.get(p.providerId);
    if (list) list.push(p);
    else byProvider.set(p.providerId, [p]);
  }
  const capped: UsageCalibPoint[] = [];
  for (const list of byProvider.values()) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    capped.push(...(list.length > CALIB_MAX_PER_PROVIDER ? list.slice(-CALIB_MAX_PER_PROVIDER) : list));
  }
  capped.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return capped.length > CALIB_MAX_LINES ? capped.slice(-CALIB_MAX_LINES) : capped;
}

function sessDelta(cur: SessionProviderTotals, prev: SessionProviderTotals): SessionProviderTotals {
  return {
    input: cur.input - prev.input,
    output: cur.output - prev.output,
    cacheRead: cur.cacheRead - prev.cacheRead,
    cacheWrite: cur.cacheWrite - prev.cacheWrite,
    apiCost: cur.apiCost - prev.apiCost,
    turns: cur.turns - prev.turns,
  };
}

/** Append one calibration sample after a successful live usage fetch.
 *  Pairs (window used + session token totals) are what make the quota→$
 *  cost estimate possible for non-token quota units (Kimi, xAI weekly %). */
function appendUsageCalibPoint(
  ctx: ExtensionContext | ExtensionCommandContext,
  usage: ProviderUsage,
): void {
  const windows: Record<string, number> = {};
  for (const w of usage.windows) windows[w.label] = w.used;
  const sess = sumSessionUsageForProvider(ctx, usage.providerId);
  const model = ctx.model?.id;
  const sessModel = model ? sumSessionUsageForProvider(ctx, usage.providerId, model) : undefined;
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  const monthly = usage.windows.find((w) => w.label === "Monthly limit");

  const point = compactCalibPoint({
    at: usage.fetchedAt,
    providerId: usage.providerId,
    windows,
    ...(monthly && monthly.limit > 0 ? { monthlyLimit: monthly.limit } : {}),
    sessionId,
    model,
    sess,
    ...(sessModel ? { sessModel } : {}),
  });

  const calibPath = getCalibPath();
  try {
    fs.mkdirSync(path.dirname(calibPath), { recursive: true });
    fs.appendFileSync(calibPath, `${JSON.stringify(point)}\n`, "utf-8");
    pruneCalibFile(calibPath);
  } catch (err) {
    console.error(`[model-manager] Failed to append usage calib: ${err}`);
  }
}

function pruneCalibFile(calibPath: string): void {
  try {
    const raw = fs.readFileSync(calibPath, "utf-8");
    const parsed: UsageCalibPoint[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line) as UsageCalibPoint);
      } catch {
        // skip bad line
      }
    }
    const kept = selectCalibPointsToKeep(parsed);
    const body = kept.length > 0 ? `${kept.map((p) => JSON.stringify(p)).join("\n")}\n` : "";
    fs.writeFileSync(calibPath, body, "utf-8");
  } catch {
    // ignore prune failures
  }
}

export interface ActiveProviderUsageResult {
  providerId: string;
  usage?: ProviderUsage;
  error?: string;
}

export async function fetchActiveProviderUsage(
  ctx: ExtensionContext | ExtensionCommandContext,
  options?: FetchUsageOptions,
): Promise<ActiveProviderUsageResult> {
  const model = ctx.model;
  if (!model) {
    return { providerId: "", error: "No model selected" };
  }
  const providerId = model.provider;
  const providerConfig = getUsageProvider(ctx, providerId);
  if (!providerConfig) {
    return { providerId, error: `Provider ${providerId} has no usage endpoint configured` };
  }
  const usage = await fetchProviderUsage(ctx, providerId, providerConfig.usageUrl, options);
  return { providerId, usage };
}

export async function fetchAllUsage(
  ctx: ExtensionContext | ExtensionCommandContext,
  options?: FetchUsageOptions,
): Promise<ProviderUsage[]> {
  const providers = getUsageProviders(ctx);
  if (providers.length === 0) return [];
  const results = await Promise.all(
    providers.map((p) => fetchProviderUsage(ctx, p.providerId, p.usageUrl, options)),
  );
  return results;
}

export function buildProviderUsageFromSnapshot(snapshot: UsageWindowSnapshotEntry[]): ProviderUsage[] {
  const byProvider = new Map<string, ProviderUsage>();
  for (const e of snapshot) {
    let pu = byProvider.get(e.providerId);
    if (!pu) {
      pu = {
        providerId: e.providerId,
        displayName: e.displayName,
        fetchedAt: e.fetchedAt,
        source: "snapshot",
        windows: [],
      };
      byProvider.set(e.providerId, pu);
    }
    pu.windows.push({
      label: e.label,
      used: e.used,
      limit: e.limit,
      remaining: e.remaining,
      resetHint: e.resetHint,
    });
  }
  return Array.from(byProvider.values());
}

export function mergeSnapshot(
  oldSnapshot: UsageWindowSnapshotEntry[],
  newUsages: ProviderUsage[],
): UsageWindowSnapshotEntry[] {
  const fresh = flattenSnapshot(newUsages);
  const fetchedProviderIds = new Set(fresh.map((e) => e.providerId));
  const kept = oldSnapshot.filter((e) => !fetchedProviderIds.has(e.providerId));
  return [...kept, ...fresh];
}

// --- Rolling fetch history (for "today" / "since last" deltas) ---

export interface UsageHistoryEntry {
  providerId: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  fetchedAt: string;
}

function getHistoryPath(): string {
  return path.join(getAgentDir(), USAGE_HISTORY_FILE);
}

function normalizeHistoryEntry(raw: unknown): UsageHistoryEntry | undefined {
  const e = raw as Partial<UsageHistoryEntry> | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
  const used = toInt(e.used);
  if (used === undefined || !e.providerId || !e.label || !e.fetchedAt) return undefined;
  return {
    providerId: String(e.providerId),
    label: String(e.label),
    used,
    limit: toInt(e.limit) ?? 0,
    remaining: toInt(e.remaining) ?? 0,
    fetchedAt: String(e.fetchedAt),
  };
}

function pruneHistory(entries: UsageHistoryEntry[]): UsageHistoryEntry[] {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const fresh = entries.filter((e) => {
    const t = new Date(e.fetchedAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  // FIFO cap: manual refreshes are low-volume, so dropping the oldest is fine.
  return fresh.length > HISTORY_MAX_ENTRIES ? fresh.slice(fresh.length - HISTORY_MAX_ENTRIES) : fresh;
}

export function loadUsageHistory(): UsageHistoryEntry[] {
  const historyPath = getHistoryPath();
  if (!fs.existsSync(historyPath)) return [];
  try {
    const raw = fs.readFileSync(historyPath, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    if (!Array.isArray(parsed.entries)) return [];
    return pruneHistory(
      parsed.entries
        .map((e) => normalizeHistoryEntry(e))
        .filter((e): e is UsageHistoryEntry => e !== undefined),
    );
  } catch (err) {
    console.error(`[model-manager] Failed to load usage history: ${err}`);
    return [];
  }
}

/**
 * Append live, non-error windows to the rolling history, prune, persist,
 * and return the full updated history. Snapshot/cached rows are ignored.
 */
export function recordUsageHistory(usages: ProviderUsage[]): UsageHistoryEntry[] {
  const history = loadUsageHistory();
  for (const pu of usages) {
    if (pu.error || pu.source === "snapshot") continue;
    for (const w of pu.windows) {
      history.push({
        providerId: pu.providerId,
        label: w.label,
        used: w.used,
        limit: w.limit,
        remaining: w.remaining,
        fetchedAt: pu.fetchedAt,
      });
    }
  }
  const pruned = pruneHistory(history);
  try {
    fs.mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
    fs.writeFileSync(getHistoryPath(), JSON.stringify({ entries: pruned }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[model-manager] Failed to save usage history: ${err}`);
  }
  return pruned;
}

/**
 * Remove snapshot entries for a provider (optionally restricted to one window label).
 * Persists the filtered snapshot and returns the remaining entries.
 */
export function clearUsageSnapshot(providerId?: string, label?: string): UsageWindowSnapshotEntry[] {
  const snapshot = loadUsageSnapshot();
  if (!providerId) {
    saveUsageSnapshot([]);
    return [];
  }
  const filtered = snapshot.filter((e) => {
    if (e.providerId !== providerId) return true;
    if (!label) return false;
    return e.label !== label;
  });
  saveUsageSnapshot(filtered);
  return filtered;
}

/**
 * Remove history entries for a provider (optionally restricted to one window label).
 * Persists the filtered history and returns the remaining entries.
 * When clearing a whole provider, also drops its snapshot so stale cached rows disappear.
 */
export function clearUsageHistory(providerId?: string, label?: string): UsageHistoryEntry[] {
  const history = loadUsageHistory();
  const filtered = history.filter((e) => {
    if (providerId && e.providerId === providerId) {
      if (!label || e.label === label) return false;
    }
    return true;
  });
  try {
    fs.mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
    fs.writeFileSync(getHistoryPath(), JSON.stringify({ entries: filtered }, null, 2), "utf-8");
  } catch (err) {
    console.error(`[model-manager] Failed to save usage history: ${err}`);
  }
  if (providerId && !label) {
    clearUsageSnapshot(providerId);
  }
  return filtered;
}

export interface UsageDeltas {
  /** Delta of `used` vs the previous fetch of this window (any time). */
  sinceLast?: number;
  sinceLastAt?: string;
  /** Delta of `used` vs the first fetch of this window today (local time). */
  today?: number;
  /** Consumption in the current weekly billing window (since last reset). */
  week?: number;
  weekAt?: string;
}

/** Window reset: used dropped by ≥5 units or ≥20% — not a 1-unit blip. */
export function isUsageMeterReset(prevUsed: number, nextUsed: number): boolean {
  if (!(nextUsed < prevUsed)) return false;
  const drop = prevUsed - nextUsed;
  return drop >= 5 || drop >= 0.2 * Math.max(Math.abs(prevUsed), 1);
}

/**
 * Week-to-date consumption for one window.
 * - `Weekly limit`: API `used` is already week-to-date unless we saw a reset,
 *   in which case we sum from that reset (equals current `used` after a clean reset).
 * - Other windows: sum of positive deltas since the last reset, or over the
 *   retained history when no reset is visible.
 */
export function computeWeekConsumption(
  history: UsageHistoryEntry[],
  providerId: string,
  label: string,
  currentUsed: number,
  currentFetchedAt: string,
): { week: number; weekAt?: string } | undefined {
  const samples: { used: number; fetchedAt: string }[] = [];
  for (const e of history) {
    if (e.providerId !== providerId || e.label !== label) continue;
    if (e.fetchedAt >= currentFetchedAt) continue;
    samples.push({ used: e.used, fetchedAt: e.fetchedAt });
  }
  samples.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  samples.push({ used: currentUsed, fetchedAt: currentFetchedAt });

  let resetIdx = -1;
  for (let i = 1; i < samples.length; i++) {
    if (isUsageMeterReset(samples[i - 1].used, samples[i].used)) resetIdx = i;
  }

  if (resetIdx < 0 && label === WEEKLY_LIMIT_LABEL) {
    return { week: currentUsed, weekAt: samples[0]?.fetchedAt };
  }
  if (resetIdx < 0 && samples.length < 2) return undefined;

  const from = resetIdx >= 0 ? resetIdx : 0;
  let week = resetIdx >= 0 ? samples[from].used : 0;
  for (let i = from + 1; i < samples.length; i++) {
    const d = samples[i].used - samples[i - 1].used;
    if (d > 0) week += d;
  }
  return { week, weekAt: samples[from]?.fetchedAt };
}

/**
 * Compute consumption deltas for a window row against the fetch history.
 * Only events strictly older than `currentFetchedAt` count, so the just-made
 * fetch never zeroes out its own deltas.
 */
export function computeUsageDeltas(
  history: UsageHistoryEntry[],
  providerId: string,
  label: string,
  currentUsed: number,
  currentFetchedAt: string,
): UsageDeltas {
  let prev: UsageHistoryEntry | undefined;
  let firstToday: UsageHistoryEntry | undefined;
  const now = new Date(currentFetchedAt);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const e of history) {
    if (e.providerId !== providerId || e.label !== label) continue;
    if (e.fetchedAt >= currentFetchedAt) continue;
    if (!prev || e.fetchedAt > prev.fetchedAt) prev = e;
    const t = new Date(e.fetchedAt).getTime();
    if (Number.isFinite(t) && t >= midnight) {
      if (!firstToday || e.fetchedAt < firstToday.fetchedAt) firstToday = e;
    }
  }
  const deltas: UsageDeltas = {};
  if (prev) {
    deltas.sinceLast = currentUsed - prev.used;
    deltas.sinceLastAt = prev.fetchedAt;
  }
  if (firstToday) {
    deltas.today = currentUsed - firstToday.used;
  }
  const weekInfo = computeWeekConsumption(history, providerId, label, currentUsed, currentFetchedAt);
  if (weekInfo) {
    deltas.week = weekInfo.week;
    deltas.weekAt = weekInfo.weekAt;
  }
  return deltas;
}

interface KimiUsagePayload {
  usage?: KimiUsageWindow;
  limits?: KimiUsageLimit[];
}

interface KimiUsageWindow {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
  reset_at?: string;
  resetAt?: string;
  reset_in?: string | number;
  resetIn?: string | number;
  ttl?: string | number;
}

interface KimiUsageLimit {
  window?: {
    duration?: string | number;
    timeUnit?: string;
  };
  detail?: KimiUsageWindow;
}

// --- OpenCode Go: GET /zen/go/v1/usage ---
//
// Live shape (verified 2026-09-25):
//   {"usage": {"rolling": {"status": "ok", "percent": 6,  "resetsAt": "ISO"},
//               "weekly":  {"status": "ok", "percent": 2,  "resetsAt": "ISO"},
//               "monthly": {"status": "ok", "percent": 1,  "resetsAt": "ISO"}}}
// Integer percent (0-100) of each window's dollar budget; dollar limits are
// NOT on the wire — windows are 20%/50%/100% of the model's monthly limit
// (see OPENCODE_GO_MONTHLY_LIMITS). Distinct from the Kimi shape, where
// `usage` is a flat {limit, used} object — detected by nested percent objects.

interface OpencodeGoWindow {
  status?: string;
  percent?: unknown;
  resetsAt?: unknown;
}

const OPENCODE_GO_WINDOW_LABELS: Array<[keyof OpencodeGoUsageShape, string]> = [
  ["weekly", WEEKLY_LIMIT_LABEL],
  ["rolling", ROLLING_5H_LIMIT_LABEL],
  ["monthly", MONTHLY_LIMIT_LABEL],
];

interface OpencodeGoUsageShape {
  rolling?: OpencodeGoWindow;
  weekly?: OpencodeGoWindow;
  monthly?: OpencodeGoWindow;
}

function isOpencodeGoPayload(payload: unknown): payload is { usage: OpencodeGoUsageShape } {
  if (!payload || typeof payload !== "object") return false;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const u = usage as Record<string, unknown>;
  // Kimi's `usage` is flat {limit, used}; OpenCode Go nests per-window objects.
  return ["rolling", "weekly", "monthly"].some((k) => {
    const w = u[k];
    return w !== null && typeof w === "object" && !Array.isArray(w);
  });
}

/**
 * Map the OpenCode Go usage snapshot onto 100-unit windows (same convention
 * as the xAI weekly-% meter), so bars, deltas, and the ≈$ conversion reuse the
 * existing UI. Returns undefined when the payload is not the OpenCode Go shape.
 * Insertion order puts "Weekly limit" first — the calib pairer takes the first
 * positive window delta, and on OpenCode Go all three windows move together.
 */
export function parseOpencodeGoPayload(payload: unknown): UsageWindow[] | undefined {
  if (!isOpencodeGoPayload(payload)) return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, label] of OPENCODE_GO_WINDOW_LABELS) {
    const w = payload.usage[key];
    if (!w) continue;
    const percent = toInt(w.percent);
    if (percent === undefined) continue;
    const used = Math.max(0, Math.min(100, percent));
    windows.push({
      label,
      used,
      limit: 100,
      remaining: 100 - used,
      resetHint: typeof w.resetsAt === "string" && w.resetsAt ? formatResetTime(w.resetsAt) : undefined,
    });
  }
  return windows.length > 0 ? windows : undefined;
}

function parseUsagePayload(payload: KimiUsagePayload): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (payload.usage && typeof payload.usage === "object") {
    const row = toUsageRow(payload.usage, "Weekly limit");
    if (row) windows.push(row);
  }
  if (Array.isArray(payload.limits)) {
    for (let i = 0; i < payload.limits.length; i++) {
      const item = payload.limits[i];
      if (!item || typeof item !== "object") continue;
      const detail = item.detail && typeof item.detail === "object" ? item.detail : item;
      const label = buildLimitLabel(item, i);
      const row = toUsageRow(detail as KimiUsageWindow, label);
      if (row) windows.push(row);
    }
  }
  return windows;
}

function toUsageRow(data: KimiUsageWindow, defaultLabel: string): UsageWindow | undefined {
  const limit = toInt(data.limit);
  let used = toInt(data.used);
  let remaining = toInt(data.remaining);
  if (used === undefined && remaining !== undefined && limit !== undefined) {
    used = limit - remaining;
  }
  if (used === undefined && limit === undefined) return undefined;
  if (used === undefined && limit !== undefined) {
    used = 0;
  }
  if (remaining === undefined && limit !== undefined && used !== undefined) {
    remaining = Math.max(0, limit - used);
  }
  return {
    label: defaultLabel,
    used: used ?? 0,
    limit: limit ?? 0,
    remaining: remaining ?? 0,
    resetHint: formatResetHint(data),
  };
}

function buildLimitLabel(item: KimiUsageLimit, index: number): string {
  const window = item.window && typeof item.window === "object" ? item.window : {};
  const duration = toInt(window.duration);
  const timeUnit = String(window.timeUnit ?? "").toUpperCase();
  if (duration) {
    if (timeUnit.includes("MINUTE") && duration >= 60 && duration % 60 === 0) {
      return `${duration / 60}h limit`;
    }
    if (timeUnit.includes("MINUTE")) return `${duration}m limit`;
    if (timeUnit.includes("HOUR")) return `${duration}h limit`;
    if (timeUnit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${index + 1}`;
}

function formatResetHint(data: KimiUsageWindow): string | undefined {
  if (data.resetTime || data.reset_at || data.resetAt) {
    const val = String(data.resetTime ?? data.reset_at ?? data.resetAt ?? "");
    return formatResetTime(val);
  }
  const seconds = toInt(data.reset_in ?? data.resetIn ?? data.ttl);
  if (seconds) return `resets in ${formatDuration(seconds)}`;
  return undefined;
}

function formatResetTime(val: string): string | undefined {
  if (!val) return undefined;
  try {
    // Trim excessive fractional seconds before any timezone offset or Z.
    const cleaned = val.replace(/\.(\d{3})\d*(Z|[+-]\d{2}:?\d{2})$/i, ".$1$2");
    const dt = new Date(cleaned);
    if (isNaN(dt.getTime())) return `resets at ${val}`;
    const now = Date.now();
    const delta = dt.getTime() - now;
    if (delta <= 0) return "reset";
    return `resets in ${formatDuration(Math.ceil(delta / 1000))}`;
  } catch {
    return `resets at ${val}`;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}


function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

// ---------------------------------------------------------------------------
// Compact number formatting and cost / burn estimation for the usage TUI.
// ---------------------------------------------------------------------------

export function formatCompact(n: number, fractionDigits = 1): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${abs.toFixed(0)}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(fractionDigits).replace(/\.0$/, "")}K`;
  if (abs < 1_000_000_000) return `${sign}${(abs / 1_000_000).toFixed(fractionDigits).replace(/\.0$/, "")}M`;
  return `${sign}${(abs / 1_000_000_000).toFixed(fractionDigits).replace(/\.0$/, "")}B`;
}

export interface CostRates {
  min: number;
  max: number;
  avg: number;
}

function getModelCostMultiplier(model: { compat?: unknown }): number {
  const raw = (model.compat as Record<string, unknown> | undefined)?.costMultiplier;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  return 1;
}

/**
 * Per-model API rates ($ per 1M tokens) for the cost estimate. Registry `cost`
 * wins; models on an api.kimi.com/coding endpoint without a registry `cost`
 * fall back to official Kimi list prices (see KIMI_MODEL_COSTS). Applies to
 * the whole Kimi endpoint — any provider id, any key.
 */
function getModelCost(m: {
  id?: string;
  baseUrl?: string;
  cost?: { input?: number; output?: number };
}): { input: number; output: number } | undefined {
  if (m.cost && (m.cost.input ?? 0) > 0 && (m.cost.output ?? 0) > 0) {
    return { input: m.cost.input!, output: m.cost.output! };
  }
  if (m.id && isKimiEndpoint(m.baseUrl)) {
    const fb = KIMI_MODEL_COSTS[m.id];
    if (fb) return { input: fb.input, output: fb.output };
  }
  return undefined;
}

export function getProviderCostRates(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): CostRates | undefined {
  const models = ctx.modelRegistry.getAll().filter((m) => m.provider === providerId);
  if (models.length === 0) return undefined;
  const inputs: number[] = [];
  const outputs: number[] = [];
  for (const m of models) {
    const cost = getModelCost(m);
    if (!cost) continue;
    const multiplier = getModelCostMultiplier(m);
    if (cost.input > 0) inputs.push(cost.input * multiplier);
    if (cost.output > 0) outputs.push(cost.output * multiplier);
  }
  if (inputs.length === 0 || outputs.length === 0) return undefined;
  const min = (Math.min(...inputs) + Math.min(...outputs)) / 1_000_000;
  const max = (Math.max(...inputs) + Math.max(...outputs)) / 1_000_000;
  const avg =
    (inputs.reduce((a, b) => a + b, 0) / inputs.length +
      outputs.reduce((a, b) => a + b, 0) / outputs.length) /
    1_000_000;
  return { min, max, avg };
}

export function formatCost(n: number): string {
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 0.1) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export interface CostEstimate {
  min: number;
  max: number;
  avg: number;
}

export function estimateCost(deltaTokens: number, rates: CostRates): CostEstimate | undefined {
  if (deltaTokens <= 0) return undefined;
  return {
    min: deltaTokens * rates.min,
    max: deltaTokens * rates.max,
    avg: deltaTokens * rates.avg,
  };
}

/**
 * Seed list-$ per 1 weekly-% when calib has no clean pairs yet.
 * grok-4.5, grok-4.6 and grok-4.7 share list rates ($2/$6, ×2 after 200k prompt)
 * and the same weekly credit bar — one seed. From clean grok-4.5 same-session pairs.
 */
const XAI_WEEKLY_LIST_DOLLARS_PER_PCT_FALLBACK: Record<string, number> = {
  "grok-4.5": 0.45,
  "grok-4.6": 0.45,
  "grok-4.7": 0.45,
};

function loadCalibPoints(providerId: string): UsageCalibPoint[] {
  const calibPath = getCalibPath();
  if (!fs.existsSync(calibPath)) return [];
  const points: UsageCalibPoint[] = [];
  try {
    const raw = fs.readFileSync(calibPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as UsageCalibPoint;
        if (p?.providerId === providerId && p.sess) points.push(p);
      } catch {
        // skip bad line
      }
    }
  } catch {
    return [];
  }
  points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return points;
}

function pairWindowDelta(prev: UsageCalibPoint, cur: UsageCalibPoint): { dq: number } | undefined {
  if (!prev.windows || !cur.windows) return undefined;
  // Weekly and 5h meter the same requests — first positive delta
  // (insertion order puts "Weekly limit" first). Caller must skip weekly
  // resets first: a 94→5 weekly drop would otherwise fall through to 5h.
  for (const [label, used] of Object.entries(cur.windows)) {
    const prevUsed = prev.windows[label];
    if (prevUsed === undefined) continue;
    const dq = used - prevUsed;
    if (dq <= 0) continue;
    return { dq };
  }
  return undefined;
}

function isKimiWeeklyReset(prev: UsageCalibPoint, cur: UsageCalibPoint): boolean {
  const a = prev.windows?.[WEEKLY_LIMIT_LABEL];
  const b = cur.windows?.[WEEKLY_LIMIT_LABEL];
  if (typeof a !== "number" || typeof b !== "number") return false;
  return isUsageMeterReset(a, b);
}

function pairSessDelta(
  prev: UsageCalibPoint,
  cur: UsageCalibPoint,
  modelId?: string,
): SessionProviderTotals | undefined {
  const useModel = modelId !== undefined && prev.sessModel && cur.sessModel;
  return sessDelta(useModel ? cur.sessModel! : cur.sess, useModel ? prev.sessModel! : prev.sess);
}

/** Drop pairs that are almost only cache with a tiny quota tick — they dominate Σ. */
function isCacheBomb(ds: SessionProviderTotals, dq: number): boolean {
  const fresh = ds.input + ds.output;
  if (fresh <= 0) return true;
  return dq < 3 && ds.cacheRead > 20 * fresh;
}

function kimiListCost(ds: SessionProviderTotals, modelId?: string): number | undefined {
  if (!modelId) return undefined;
  const rates = KIMI_MODEL_COSTS[modelId];
  if (!rates) return undefined;
  const dollars =
    (ds.input * rates.input + ds.output * rates.output + ds.cacheRead * (rates.cacheRead ?? 0)) /
    1_000_000;
  return dollars > 0 ? dollars : undefined;
}

function groupCalibBySession(points: UsageCalibPoint[]): UsageCalibPoint[][] {
  const bySession = new Map<string, UsageCalibPoint[]>();
  for (const p of points) {
    if (!p.sessionId) continue;
    let list = bySession.get(p.sessionId);
    if (!list) {
      list = [];
      bySession.set(p.sessionId, list);
    }
    list.push(p);
  }
  return Array.from(bySession.values());
}

function eachKimiCalibPair(
  providerId: string,
  modelId: string | undefined,
  visit: (dq: number, ds: SessionProviderTotals, pairModel: string | undefined, at: string) => void,
): void {
  // Consecutive *per session*, not globally — interleaved /usage from parallel
  // sessions would otherwise drop every same-session pair.
  for (const sessionPoints of groupCalibBySession(loadCalibPoints(providerId))) {
    for (let i = 1; i < sessionPoints.length; i++) {
      const prev = sessionPoints[i - 1];
      const cur = sessionPoints[i];
      if (modelId !== undefined && (prev.model !== modelId || cur.model !== modelId)) continue;
      // Blend (no modelId): skip mid-session model switches — those mix two meters.
      if (modelId === undefined && prev.model && cur.model && prev.model !== cur.model) continue;
      // Weekly reset (e.g. 94→5): do not take the leftover 5h positive delta.
      if (isKimiWeeklyReset(prev, cur)) continue;
      const win = pairWindowDelta(prev, cur);
      if (!win) continue;
      const ds = pairSessDelta(prev, cur, modelId);
      if (!ds || isCacheBomb(ds, win.dq)) continue;
      visit(win.dq, ds, cur.model, cur.at);
    }
  }
}

/**
 * Empirical quota→tokens conversion for Kimi Code. The `/usages` windows meter
 * a weighted unit (docs: k3 consumes ~2× the quota of k3-256k, HighSpeed ~3×),
 * so Δquota cannot be multiplied by a $/token rate directly. Instead, pair
 * consecutive live fetches that happened within the same Pi session: both
 * Δquota (usage window) and Δtokens (session usage) are known, and
 * tokens/quota-unit = ΣΔtokens / ΣΔquota. Uses billable tokens only
 * (input + output + cacheRead; cacheWrite is free on Kimi).
 *
 * Pass `modelId` to restrict to pairs where BOTH fetches ran on that model —
 * the quota meter is per-model (k3 tokens cost ~2× the quota of k3-256k
 * tokens), so per-model ratios keep k3 and k3-256k from polluting each other.
 * Returns undefined until at least one valid same-session pair exists.
 */
export function getTokensPerQuotaUnit(providerId: string, modelId?: string): number | undefined {
  let totalTokens = 0;
  let totalQuota = 0;
  eachKimiCalibPair(providerId, modelId, (dq, ds) => {
    const dt = ds.input + ds.output + ds.cacheRead;
    if (dt <= 0) return;
    totalTokens += dt;
    totalQuota += dq;
  });
  if (totalQuota <= 0) return undefined;
  return totalTokens / totalQuota;
}

/**
 * Empirical list-$ per 1 Kimi quota unit. Same-session consecutive `/usage`
 * pairs: Σ list$(Δtokens) / ΣΔquota. List $ uses official per-model rates
 * (cache at cacheRead), not Pi `apiCost` — catalog `k3-256k` ships cost=0.
 * Per-model when `modelId` is set; undefined until ≥1 clean pair.
 */
export function getListDollarsPerQuotaUnit(providerId: string, modelId?: string): number | undefined {
  return getKimiCalibStats(providerId, modelId)?.dollarsPerUnit;
}

export interface KimiCalibStats {
  pairs: number;
  dollarsPerUnit: number;
  totalQuota: number;
  lastAt?: string;
}

/** Clean same-session Kimi pairs that feed `/usage` ≈$ / bar. Undefined until ≥1 pair. */
export function getKimiCalibStats(providerId: string, modelId?: string): KimiCalibStats | undefined {
  let totalDollars = 0;
  let totalQuota = 0;
  let pairs = 0;
  let lastAt: string | undefined;
  eachKimiCalibPair(providerId, modelId, (dq, ds, pairModel, at) => {
    const dollars = kimiListCost(ds, modelId ?? pairModel);
    if (dollars === undefined) return;
    totalDollars += dollars;
    totalQuota += dq;
    pairs += 1;
    if (!lastAt || at > lastAt) lastAt = at;
  });
  if (pairs <= 0 || totalQuota <= 0 || totalDollars <= 0) return undefined;
  return { pairs, dollarsPerUnit: totalDollars / totalQuota, totalQuota, lastAt };
}

/**
 * Drop xAI pairs whose $/pct is implausible. Band is around the $0.45 seed
 * (integer-% noise, parallel sessions, 200k-cliff cache bombs). Opening
 * `/usage` anytime is safe — junk is ignored, not a calib ritual.
 */
const XAI_DOLLARS_PER_PCT_MIN = 0.2;
const XAI_DOLLARS_PER_PCT_MAX = 0.8;
/** Weekly meter is integer %. +1/+2 is mostly rounding; need a real tick. */
const XAI_MIN_PAIR_PCT = 3;
/** One lucky/unlucky pair must not override the seed. */
const XAI_MIN_TOTAL_PCT = 8;

function xaiWeeklyPct(point: UsageCalibPoint): number | undefined {
  const n = point.windows?.[WEEKLY_LIMIT_LABEL];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * True when another Pi session hit `/usage` between these two points.
 * The weekly bar is global (this login + grok.com). Any other snapshot in
 * the interval — even if % had not ticked yet — means the Δ% is not ours.
 */
function xaiPairContaminated(all: UsageCalibPoint[], prev: UsageCalibPoint, cur: UsageCalibPoint): boolean {
  for (const p of all) {
    if (!p.sessionId || p.sessionId === prev.sessionId) continue;
    if (p.at <= prev.at || p.at >= cur.at) continue;
    return true;
  }
  return false;
}

/**
 * Empirical list-$ per 1 weekly-percent for xAI/Grok subscription.
 * Pairs consecutive `/usage` fetches *within the same Pi session* (not just
 * adjacent lines — parallel sessions interleave). grok-4.5 and grok-4.6 are
 * pooled: same list rates, same weekly bar (`modelId` is ignored). Skips:
 * - old SuperGrok monthly-plan points (`monthlyLimit > 0`)
 * - weekly resets and Δ% < 3 (integer meter)
 * - any other session's `/usage` in the interval (parallel / grok.com)
 * - outlier $/pct outside 0.20–0.80 (around the $0.45 seed)
 * Returns undefined until survivors sum to Δ% ≥ 8 — overlay then keeps seed.
 * ΣΔsess.apiCost / ΣΔweekly% on the survivors.
 */
export function getListDollarsPerWeeklyPct(providerId: string, _modelId?: string): number | undefined {
  const points = loadCalibPoints(providerId);
  let totalDollars = 0;
  let totalPct = 0;
  for (const sessionPoints of groupCalibBySession(points)) {
    for (let i = 1; i < sessionPoints.length; i++) {
      const prev = sessionPoints[i - 1];
      const cur = sessionPoints[i];
      if ((prev.monthlyLimit ?? 0) > 0 || (cur.monthlyLimit ?? 0) > 0) continue;
      if (!prev.windows || !cur.windows) continue;
      const prevPct = xaiWeeklyPct(prev);
      const curPct = xaiWeeklyPct(cur);
      if (prevPct === undefined || curPct === undefined) continue;
      const dp = curPct - prevPct;
      if (dp < XAI_MIN_PAIR_PCT) continue;
      if (xaiPairContaminated(points, prev, cur)) continue;
      // Full session vs the global weekly bar — not sessModel. 4.5/4.6 share rates.
      const ds = sessDelta(cur.sess, prev.sess);
      if (!(ds.apiCost > 0)) continue;
      const ratio = ds.apiCost / dp;
      if (ratio < XAI_DOLLARS_PER_PCT_MIN || ratio > XAI_DOLLARS_PER_PCT_MAX) continue;
      totalDollars += ds.apiCost;
      totalPct += dp;
    }
  }
  if (totalPct < XAI_MIN_TOTAL_PCT || totalDollars <= 0) return undefined;
  return totalDollars / totalPct;
}

function providerUsesKimiQuota(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): boolean {
  return ctx.modelRegistry.getAll().some((m) => m.provider === providerId && isKimiEndpoint(m.baseUrl));
}

function providerUsesOpencodeGo(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): boolean {
  return ctx.modelRegistry.getAll().some((m) => {
    if (m.provider !== providerId) return false;
    return OPENCODE_USAGE_PATTERNS.some((p) => (m.baseUrl ?? "").toLowerCase().includes(p));
  });
}

function providerUsesXaiBilling(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
): boolean {
  if (providerId.toLowerCase() === "xai") return true;
  return ctx.modelRegistry.getAll().some((m) => {
    if (m.provider !== providerId) return false;
    const base = (m.baseUrl ?? "").toLowerCase();
    return XAI_USAGE_PATTERNS.some((p) => base.includes(p));
  });
}

/**
 * Cost estimate for a quota delta.
 * - **Kimi:** weighted quota units → calib list-$ / quota unit (per-model).
 * - **xAI weekly %:** calib list-$ per weekly-% (same-session pairs, 4.5+4.6
 *   pooled — same list rates; short / parallel / outlier pairs dropped, and
 *   live rate ignored until ΣΔ% ≥ 8), $0.45 seed otherwise; monthly = none.
 * - **OpenCode Go %:** pure docs-table conversion (rolling = 0.2×, weekly =
 *   0.5×, monthly = 1× of the active model's monthly limit). Deliberately NO
 *   empirical override: the public table defines the meter, and mixed-model
 *   ΣΔapiCost/ΣΔ% would average unrelated price tiers.
 * - **Other:** direct Δ×$/token (delta treated as tokens).
 * Returns undefined when no conversion is available yet instead of a
 * misleading near-zero number.
 *
 * `label` disambiguates multi-window providers (pass the row's window label).
 */
export function estimateUsageCost(
  ctx: ExtensionContext | ExtensionCommandContext,
  providerId: string,
  delta: number,
  label?: string,
): CostEstimate | undefined {
  if (delta <= 0) return undefined;
  const modelId = ctx.model?.id;

  if (providerUsesXaiBilling(ctx, providerId)) {
    // Monthly credits (when present) are a different unit; no formula yet.
    if (label === MONTHLY_LIMIT_LABEL) return undefined;
    // Weekly % (default when label omitted — monthly is usually hidden).
    if (label !== undefined && label !== WEEKLY_LIMIT_LABEL) return undefined;
    let dollarsPerPct = getListDollarsPerWeeklyPct(providerId, modelId);
    if (dollarsPerPct === undefined || dollarsPerPct <= 0) {
      dollarsPerPct = getListDollarsPerWeeklyPct(providerId);
    }
    if (dollarsPerPct === undefined || dollarsPerPct <= 0) {
      const fb = modelId ? XAI_WEEKLY_LIST_DOLLARS_PER_PCT_FALLBACK[modelId] : undefined;
      if (fb === undefined || fb <= 0) return undefined;
      dollarsPerPct = fb;
    }
    const avg = delta * dollarsPerPct;
    return { min: avg, max: avg, avg };
  }

  if (providerUsesOpencodeGo(ctx, providerId)) {
    // Percent of a dollar window: rolling 5h = 20%, weekly = 50%, monthly =
    // 100% of the model's monthly limit. No empirical override here (unlike
    // Kimi/xAI): the public docs/go table IS the meter definition — opencode
    // computes % from these dollar budgets — while ΣΔapiCost/ΣΔ% would blend
    // whatever models the pairs happened to use ($0.10–$4 input range,
    // off-peak/peak DeepSeek) into one meaningless average. Table only.
    if (label !== ROLLING_5H_LIMIT_LABEL && label !== WEEKLY_LIMIT_LABEL && label !== MONTHLY_LIMIT_LABEL) {
      return undefined;
    }
    const share = label === ROLLING_5H_LIMIT_LABEL ? 0.2 : label === WEEKLY_LIMIT_LABEL ? 0.5 : 1;
    const monthlyLimit = modelId ? OPENCODE_GO_MONTHLY_LIMITS[modelId] : undefined;
    if (monthlyLimit === undefined || monthlyLimit <= 0) return undefined;
    const avg = (delta * share * monthlyLimit) / 100;
    return { min: avg, max: avg, avg };
  }

  if (providerUsesKimiQuota(ctx, providerId)) {
    // Prefer the active model's own $/unit (quota is metered per model —
    // k3 ~2× k3-256k), fall back to the same-model-pair blend.
    let dollarsPerUnit = getListDollarsPerQuotaUnit(providerId, modelId);
    if (dollarsPerUnit === undefined || dollarsPerUnit <= 0) {
      dollarsPerUnit = getListDollarsPerQuotaUnit(providerId);
    }
    if (dollarsPerUnit === undefined || dollarsPerUnit <= 0) return undefined;
    const avg = delta * dollarsPerUnit;
    return { min: avg, max: avg, avg };
  }

  const rates = getProviderCostRates(ctx, providerId);
  if (!rates) return undefined;
  return estimateCost(delta, rates);
}

export interface BurnProjection {
  unitsPerHour: number;
  hoursRemaining: number;
  daysRemaining: number;
}

export function computeBurnProjection(
  history: UsageHistoryEntry[],
  providerId: string,
  label: string,
  currentUsed: number,
  currentLimit: number,
  currentFetchedAt: string,
): BurnProjection | undefined {
  if (currentLimit <= 0) return undefined;
  const relevant = history
    .filter((e) => e.providerId === providerId && e.label === label)
    .sort((a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime());
  if (relevant.length < 2) return undefined;
  const oldest = relevant[0];
  const now = new Date(currentFetchedAt).getTime();
  const oldestTime = new Date(oldest.fetchedAt).getTime();
  const elapsedHours = (now - oldestTime) / (1000 * 60 * 60);
  if (elapsedHours <= 0) return undefined;
  const delta = currentUsed - oldest.used;
  if (delta <= 0) return undefined;
  const unitsPerHour = delta / elapsedHours;
  const remaining = currentLimit - currentUsed;
  if (remaining <= 0) return { unitsPerHour, hoursRemaining: 0, daysRemaining: 0 };
  const hoursRemaining = remaining / unitsPerHour;
  return { unitsPerHour, hoursRemaining, daysRemaining: hoursRemaining / 24 };
}

export function formatBurnProjection(p: BurnProjection): string {
  if (p.hoursRemaining <= 0) return "limit exhausted";
  if (p.hoursRemaining < 1) return `${p.unitsPerHour.toFixed(0)}/h · runs out in <1h`;
  if (p.daysRemaining < 1) return `${formatCompact(p.unitsPerHour)}/h · runs out in ${p.hoursRemaining.toFixed(1)}h`;
  return `${formatCompact(p.unitsPerHour)}/h · runs out in ${p.daysRemaining.toFixed(1)}d`;
}

const SPARK_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function buildSparkline(
  history: UsageHistoryEntry[],
  providerId: string,
  label: string,
  width: number,
): string {
  const entries = history
    .filter((e) => e.providerId === providerId && e.label === label)
    .sort((a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime());
  if (entries.length < 2) return "";
  const values = entries.map((e) => e.used);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range <= 0) return SPARK_BARS[0].repeat(Math.min(width, entries.length));
  const points = entries.slice(-width);
  return points
    .map((e) => {
      const ratio = (e.used - min) / range;
      const idx = Math.min(SPARK_BARS.length - 1, Math.floor(ratio * (SPARK_BARS.length - 1)));
      return SPARK_BARS[idx];
    })
    .join("");
}
