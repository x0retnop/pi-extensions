export type BrowserToolToggleKey = "browser" | "browser_network" | "browser_state" | "browser_debug";

export interface AgentBrowserState {
  enabled: Record<BrowserToolToggleKey, boolean>;
  /** Last cdp_url used in this session. Auto-applied to subsequent calls. */
  cdpUrl?: string;
  /** Cached snapshot output for @eN fallback lookups. */
  lastSnapshot?: string;
}

export interface AgentBrowserResult {
  ok: boolean;
  output: string;
  error?: string;
}

export const BROWSER_TOOLS: BrowserToolToggleKey[] = [
  "browser",
  "browser_network",
  "browser_state",
  "browser_debug",
];

export const TOOL_LABELS: Record<BrowserToolToggleKey, string> = {
  browser: "Core browser automation",
  browser_network: "Network interception",
  browser_state: "Cookies / storage / auth",
  browser_debug: "CDP / console / React / vitals",
};

export const TOOL_HINTS: Record<BrowserToolToggleKey, string> = {
  browser: "open, snapshot, click, fill, type, eval, text, submit, screenshot, close",
  browser_network: "route, unroute, requests, har_start/stop",
  browser_state: "cookies, storage, state save/load",
  browser_debug: "console, errors, trace, react_tree, vitals",
};

export const CUSTOM_STATE_TYPE = "agent-browser-state";
