/**
 * ui-theme — single hub for TUI chrome:
 *   custom footer + tok/s rate + ASCII banner + Working… toggle
 *   presets (Pi theme + chrome pack) via /ui-theme or /ui-theme preset <id>
 *   /footer, /banner — shortcuts
 *
 * Functional status producers (a-rewind timer, role-sw, sub-agents) stay put —
 * they push setStatus; this hub only hosts/skins the chrome.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type UiThemeSettings,
  loadFromCtx,
  saveUiThemeSettings,
} from "./settings.js";
import {
  applyFooterFromSettings,
  installFooter,
  requestFooterRender,
  restoreBuiltinFooter,
  setFooterCtx,
  setFooterDeps,
} from "./footer.js";
import {
  applyRateFromSettings,
  clearRateStatus,
  onRateMessageEnd,
  onRateMessageStart,
  onRateMessageUpdate,
  resetRateState,
  setRateCtx,
  setRateDeps,
  startRateTick,
  stopRateTick,
  updateRateStatus,
} from "./rate.js";
import { takeBootRibbon } from "../common/chrome.js";
import { artsDir, showBanner } from "./banner.js";
import { applyWorkingVisible } from "./working.js";
import {
  onProviderResponse,
  onToolEnd,
  onToolStart,
  onTurnEnd,
  onTurnStart,
  refreshTurnLogStatus,
  registerTurnLogRenderer,
  resetTurnLog,
  runTimestampsCommand,
  setTurnLogDeps,
  shutdownTurnLog,
} from "./turnlog.js";
import type { MenuActions } from "./menu.js";

let settings: UiThemeSettings = loadFromCtx(null);
let currentCtx: ExtensionContext | null = null;

function getSettings(): UiThemeSettings {
  return settings;
}

function setSettings(s: UiThemeSettings): void {
  settings = s;
}

function applyAll(ctx: ExtensionContext): void {
  currentCtx = ctx;
  setFooterCtx(ctx);
  setRateCtx(ctx);
  applyFooterFromSettings(ctx);
  applyRateFromSettings();
  applyWorkingVisible(ctx, settings.working);
  refreshTurnLogStatus(ctx);
  if (settings.rate && ctx.hasUI) startRateTick();
  else stopRateTick();
}

function menuActions(): MenuActions {
  return {
    getSettings,
    setSettings,
    applyAll,
    showBanner: (c, name) => showBanner(c, name),
  };
}

function splashIfEnabled(ctx: ExtensionContext, reason: string): void {
  // Defer past the initial transcript render: on startup renderInitialMessages
  // runs synchronously after session_start, so notifying earlier would put the
  // splash above the history instead of at the current view (end of chat).
  // Always take the pending boot ribbon so it is not left for a later session.
  setTimeout(() => {
    const boot = takeBootRibbon();
    const wantArt = settings.banner && reason !== "reload";
    if (wantArt) {
      showBanner(ctx, settings.bannerPrefer || undefined, boot);
      return;
    }
    if (boot?.length && ctx.hasUI && typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(boot.join("\n"), "info");
    }
  }, 0);
}

export default function uiTheme(pi: ExtensionAPI): void {
  setFooterDeps({ getSettings });
  setRateDeps({ getSettings });
  setTurnLogDeps({
    getSettings,
    setSettings: (s) => {
      settings = s;
      saveUiThemeSettings(s);
    },
  });
  registerTurnLogRenderer(pi);

  pi.on("session_start", (event, ctx: ExtensionContext) => {
    currentCtx = ctx;
    settings = loadFromCtx(ctx as any);
    setFooterCtx(ctx);
    setRateCtx(ctx);
    resetRateState();
    resetTurnLog(ctx);

    applyWorkingVisible(ctx, settings.working);
    applyFooterFromSettings(ctx);

    if (settings.rate) {
      updateRateStatus();
      if (ctx.hasUI) startRateTick();
    } else {
      clearRateStatus();
    }

    splashIfEnabled(ctx, event.reason);
  });

  pi.on("session_shutdown", () => {
    stopRateTick();
    resetRateState();
    shutdownTurnLog();
    if (currentCtx) {
      restoreBuiltinFooter(currentCtx);
      try {
        clearRateStatus();
      } catch {
        // ignore
      }
    }
    currentCtx = null;
    setFooterCtx(null);
    setRateCtx(null);
  });

  pi.on("turn_start", (event, ctx: ExtensionContext) => {
    onTurnStart(event, ctx);
  });

  pi.on("model_select", (_event, ctx: ExtensionContext) => {
    currentCtx = ctx;
    setFooterCtx(ctx);
    setRateCtx(ctx);
    requestFooterRender();
    updateRateStatus();
  });
  pi.on("turn_end", (event, ctx: ExtensionContext) => {
    onTurnEnd(event, ctx);
    requestFooterRender();
  });
  pi.on("tool_execution_start", (event) => {
    onToolStart(event as any);
  });
  pi.on("tool_execution_end", (event) => {
    onToolEnd(event as any);
  });
  pi.on("after_provider_response", (event) => {
    onProviderResponse(event as any);
  });
  pi.on("agent_settled", () => requestFooterRender());
  pi.on("message_end", () => {
    onRateMessageEnd();
    requestFooterRender();
  });
  pi.on("tool_call", () => requestFooterRender());
  pi.on("session_compact", () => requestFooterRender());

  pi.on("message_start", (_event, ctx: ExtensionContext) => {
    onRateMessageStart(ctx);
  });
  pi.on("message_update", (event) => {
    onRateMessageUpdate(event as any);
  });

  pi.registerCommand("ui-theme", {
    description: "TUI chrome + presets + Pi theme (/ui-theme preset <id>)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      currentCtx = ctx;
      settings = loadFromCtx(ctx as any);

      const a = (args ?? "").trim();
      const { applyPresetByName, runUiThemeMenu } = await import("./menu.js");
      if (a) {
        const parts = a.split(/\s+/);
        const head = parts[0].toLowerCase();
        if (head === "preset" || head === "p") {
          const name = parts.slice(1).join(" ").trim();
          if (!name) {
            const { loadPresets } = await import("./presets.js");
            const list = loadPresets()
              .map((p) => `${p.id}${p.piTheme ? ` → ${p.piTheme}` : ""} — ${p.description || p.name}`)
              .join("\n");
            ctx.ui.notify(list || "No presets loaded", list ? "info" : "warning");
            return;
          }
          applyPresetByName(ctx, menuActions(), name);
          return;
        }
        // bare name = preset shorthand
        if (applyPresetByName(ctx, menuActions(), a)) return;
        ctx.ui.notify(`Unknown args. Try /ui-theme or /ui-theme preset <id>`, "warning");
        return;
      }

      await runUiThemeMenu(ctx, menuActions());
    },
  });

  pi.registerCommand("footer", {
    description: "Toggle custom footer (frame: toggle gradient frame)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      currentCtx = ctx;
      const a = (args ?? "").trim().toLowerCase();
      if (a === "frame") {
        settings = { ...settings, frame: !settings.frame, preset: "" };
        saveUiThemeSettings(settings);
        if (settings.footer) installFooter(ctx);
        ctx.ui.notify(`ui-theme: frame ${settings.frame ? "on" : "off"}`, "info");
        return;
      }
      if (a === "on") settings = { ...settings, footer: true, preset: "" };
      else if (a === "off") settings = { ...settings, footer: false, preset: "" };
      else settings = { ...settings, footer: !settings.footer, preset: "" };
      saveUiThemeSettings(settings);
      applyFooterFromSettings(ctx);
      ctx.ui.notify(`ui-theme: footer ${settings.footer ? "custom" : "built-in"}`, "info");
    },
  });

  pi.registerCommand("banner", {
    description: "Show a random ASCII banner in the chat (or /banner <name>)",
    handler: async (args, ctx) => {
      const name = (args ?? "").trim() || settings.bannerPrefer || undefined;
      const shown = showBanner(ctx, name);
      if (!shown) {
        ctx.ui.notify(`No arts in ${artsDir()}`, "warning");
      }
    },
  });

  pi.registerCommand("timestamps", {
    description: "Turn timeline: on|off entries · status on|off · all (scrollable list)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await runTimestampsCommand(args, ctx as ExtensionContext);
    },
  });
}
