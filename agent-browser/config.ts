import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentBrowserState, BrowserToolToggleKey } from "./types.js";
import { CUSTOM_STATE_TYPE, BROWSER_TOOLS } from "./types.js";

export function getDefaultState(): AgentBrowserState {
  return {
    enabled: Object.fromEntries(BROWSER_TOOLS.map((k) => [k, false])) as Record<
      BrowserToolToggleKey,
      boolean
    >,
  };
}

export function getLatestState(ctx: ExtensionContext): AgentBrowserState {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === CUSTOM_STATE_TYPE) {
      const data = entry.data as Partial<AgentBrowserState> | undefined;
      return normalizeState(data);
    }
  }
  return getDefaultState();
}

export function normalizeState(data: Partial<AgentBrowserState> | undefined): AgentBrowserState {
  const def = getDefaultState();
  if (!data || typeof data !== "object") return def;
  const enabled = data.enabled;
  if (enabled && typeof enabled === "object") {
    for (const key of BROWSER_TOOLS) {
      def.enabled[key] = Boolean(enabled[key]);
    }
  }
  if (typeof data.cdpUrl === "string") def.cdpUrl = data.cdpUrl;
  if (typeof data.lastSnapshot === "string") def.lastSnapshot = data.lastSnapshot;
  return def;
}
