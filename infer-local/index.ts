/**
 * infer-local — stand-in for a hand-written `models.json` provider.
 *
 * A written provider sits still: no startup fetch, no catalog refresh. This extension
 * registers the same shape (baseUrl, dummy key, compat, model rows, optional
 * `X-Infer-Preset`) from the last gateway snapshot on disk. The gateway is contacted
 * only when `/mm` asks for a refresh on this provider.
 *
 * Why not `refreshModels`: `registerProvider` fires `refresh({ allowNetwork: false })`,
 * and a callback that ignores that flag probes the gateway on every registration —
 * including the one at load, which Pi awaits before the themed footer is installed.
 *
 * Config:   ~/.pi/agent/infer-local.json (optional, see config.ts)
 * Cache:    ~/.pi/agent/infer-local-cache.json
 *
 * No slash command. `/mm` → this provider → Refresh from gateway asks over
 * `pi.events` (channels below). A direct import would be a second module copy
 * under jiti and would not see this registration.
 */

/** model-manager pings this synchronously; `ids` is called before emit returns. */
export const INFER_LOCAL_PROVIDERS = "infer-local:providers";
/** model-manager calls `ack` sync, then awaits `done` after the probe. */
export const INFER_LOCAL_REFRESH = "infer-local:refresh";

import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPAT, loadConfig, readCachedSnapshot, writeCachedSnapshot, type InferLocalConfig } from "./config.js";
import {
  describeSnapshot,
  fetchSnapshot,
  presetDisplayName,
  presetProviderId,
  presetPublished,
  rowsForSnapshot,
  type ChatRow,
  type LiveSnapshot,
} from "./gateway.js";

interface Registration {
  id: string;
  config: ProviderConfig;
}

function configStamp(config: InferLocalConfig): string {
  return JSON.stringify({
    baseUrl: config.baseUrl,
    providerId: config.providerId,
    name: config.name,
    presets: config.presets,
    defaultPreset: config.defaultPreset,
    maxTokensCap: config.maxTokensCap ?? null,
    contextWindowFallback: config.contextWindowFallback ?? null,
    compat: config.compat ?? null,
    thinkingLevelMap: config.thinkingLevelMap ?? null,
  });
}

export default function (pi: ExtensionAPI) {
  let config: InferLocalConfig = loadConfig();
  let snapshot: LiveSnapshot | null = readCachedSnapshot();
  let registeredStamp = "";
  const registered = new Set<string>();
  let lastError: string | null = null;

  /** One in-flight probe for the explicit commands. Never called from load or session_start. */
  let inflight: Promise<LiveSnapshot | null> | null = null;

  async function probe(): Promise<LiveSnapshot | null> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const fresh = await fetchSnapshot(config.baseUrl);
        snapshot = fresh;
        writeCachedSnapshot(fresh);
        lastError = null;
        return fresh;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return snapshot;
      }
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function rows(snap: LiveSnapshot | null, preset: string | null): ChatRow[] {
    if (!snap) return [];
    return rowsForSnapshot(snap, {
      preset,
      maxTokensCap: config.maxTokensCap,
      contextWindowFallback: config.contextWindowFallback,
      thinkingLevelMap: config.thinkingLevelMap,
    });
  }

  function buildRegistrations(snap: LiveSnapshot | null): Registration[] {
    const compat = { ...DEFAULT_COMPAT, ...(config.compat ?? {}) };
    // Pin only when the stored snapshot says the gateway publishes the name. A name it
    // does not know would 400 every local request; passthrough is the safe written-down row.
    const basePreset = presetPublished(snap, config.defaultPreset) ? config.defaultPreset : null;
    const variants: Array<{ id: string; preset: string | null; name: string }> = [
      { id: config.providerId, preset: basePreset, name: config.name },
      ...config.presets.map((preset) => ({
        id: presetProviderId(config.providerId, preset),
        preset,
        name: presetDisplayName(config.name, preset),
      })),
    ];
    return variants.map(({ id, preset, name }) => ({
      id,
      config: {
        name,
        baseUrl: config.baseUrl,
        api: "openai-completions",
        // A literal dummy key: without it Pi treats an extension provider as unauthenticated
        // and drops its models from the selector. The gateway is unauthenticated itself
        // (`/v1/manifest` → "auth": "none") and ignores the resulting Bearer header.
        apiKey: "local",
        ...(preset ? { headers: { "X-Infer-Preset": preset } } : {}),
        compat,
        models: rows(snap, preset),
      },
    }));
  }

  /** Install the stored snapshot. No network. Skipped when nothing about the registration changed. */
  function install(force = false): void {
    const stamp = `${configStamp(config)}\n${snapshot?.fetchedAt ?? ""}`;
    if (!force && stamp === registeredStamp) return;
    const wanted = buildRegistrations(snapshot);
    const wantedIds = new Set(wanted.map((entry) => entry.id));
    for (const id of [...registered]) {
      if (wantedIds.has(id)) continue;
      try {
        pi.unregisterProvider(id);
      } catch {
        /* provider already gone */
      }
      registered.delete(id);
    }
    for (const entry of wanted) {
      try {
        pi.registerProvider(entry.id, entry.config);
        registered.add(entry.id);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    registeredStamp = stamp;
  }

  function statusLine(): string {
    const stored = snapshot
      ? `${describeSnapshot(snapshot)} (stored ${snapshot.fetchedAt})`
      : "no stored snapshot — /mm → Refresh from gateway";
    const presets = config.presets.length ? config.presets.join(", ") : "(none)";
    const pin = config.defaultPreset
      ? presetPublished(snapshot, config.defaultPreset)
        ? `${config.defaultPreset} (pinned on the base row)`
        : `${config.defaultPreset} (not in the stored snapshot — passthrough; refresh from /mm to re-check)`
      : "(none)";
    const trouble = lastError ? ` — last error: ${lastError}` : "";
    return `${config.providerId} @ ${config.baseUrl} — ${stored}; default preset: ${pin}; extra preset rows: ${presets}${trouble}`;
  }

  install();

  // A config edit lands on the next session without a probe. Unchanged config does not
  // re-register — registerProvider would kick Pi's catalog refresh for nothing.
  pi.on("session_start", () => {
    const next = loadConfig();
    if (configStamp(next) === configStamp(config)) return;
    config = next;
    install();
  });

  pi.events.on(INFER_LOCAL_PROVIDERS, (data) => {
    const req = data as { ids?: (ids: string[]) => void };
    req.ids?.(buildRegistrations(snapshot).map((entry) => entry.id));
  });

  pi.events.on(INFER_LOCAL_REFRESH, (data) => {
    const req = data as { ack?: () => void; done?: (result: { ok: boolean; line: string }) => void };
    req.ack?.();
    void (async () => {
      try {
        config = loadConfig();
        const snap = await probe();
        install(true);
        if (!snap) lastError ??= `gateway not reachable at ${config.baseUrl}`;
        req.done?.({ ok: !lastError, line: statusLine() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        req.done?.({ ok: false, line: message });
      }
    })();
  });
}
