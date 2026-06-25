import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { setStatusBlock } from "../common/status.js";
import { getLatestState, normalizeState } from "./config.js";
import { MainScreen } from "./ui/main-screen.js";
import { browserToolDefinition } from "./tools/browser.js";
import { networkToolDefinition } from "./tools/network.js";
import { stateToolDefinition } from "./tools/state.js";
import { debugToolDefinition } from "./tools/debug.js";
import { helpToolDefinition } from "./tools/help.js";
import {
  BROWSER_TOOLS,
  HELP_TOOL,
  CUSTOM_STATE_TYPE,
  TOOL_LABELS,
  type AgentBrowserState,
} from "./types.js";

const ALL_BROWSER_TOOLS = [...BROWSER_TOOLS, HELP_TOOL];

export default function agentBrowserExtension(pi: ExtensionAPI) {
  function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function applyBrowserTools(state: AgentBrowserState): string[] {
    const active = new Set(pi.getActiveTools());
    for (const t of ALL_BROWSER_TOOLS) active.delete(t);
    for (const key of BROWSER_TOOLS) {
      if (state.enabled[key]) active.add(key);
    }
    const anyEnabled = BROWSER_TOOLS.some((k) => state.enabled[k]);
    if (anyEnabled) active.add(HELP_TOOL);
    return [...active];
  }

  function syncActiveTools(ctx: ExtensionContext): void {
    const state = getLatestState(ctx);
    pi.setActiveTools(applyBrowserTools(state));
    setStatusBlock(ctx, "browser", BROWSER_TOOLS.some((k) => state.enabled[k]) ? "browser:on" : undefined);
  }

  function persistAndSync(ctx: ExtensionContext | ExtensionCommandContext, state: AgentBrowserState): void {
    pi.appendEntry(CUSTOM_STATE_TYPE, state);
    pi.setActiveTools(applyBrowserTools(state));
    setStatusBlock(ctx, "browser", BROWSER_TOOLS.some((k) => state.enabled[k]) ? "browser:on" : undefined);
  }

  // Register all tool definitions so they exist in pi.getAllTools().
  pi.registerTool(browserToolDefinition);
  pi.registerTool(networkToolDefinition);
  pi.registerTool(stateToolDefinition);
  pi.registerTool(debugToolDefinition);
  pi.registerTool(helpToolDefinition);

  pi.on("session_start", (_event, ctx) => {
    syncActiveTools(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    syncActiveTools(ctx);
  });

  pi.registerCommand("browser", {
    description: "Open the browser tools gate TUI (/browser).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notify(ctx, "Browser manager requires TUI mode.", "warning");
        return;
      }
      await openBrowserGate(ctx);
    },
  });

  async function openBrowserGate(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    const state = normalizeState(getLatestState(ctx));
    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      const screen = new MainScreen(tui, theme, kb, ctx, state, (action) => {
        switch (action.type) {
          case "toggle":
            // live update local state only; save happens on q.
            break;
          case "save":
            persistAndSync(ctx, action.state);
            {
              const enabledNames = BROWSER_TOOLS.filter((k) => action.state.enabled[k]).map((k) => TOOL_LABELS[k]);
              notify(
                ctx,
                enabledNames.length
                  ? `Browser tools enabled: ${enabledNames.join(", ")}`
                  : "All browser tools disabled",
                "info",
              );
            }
            done();
            return;
          case "close":
            done();
            return;
        }
      });

      return {
        render(width: number) {
          return screen.render(width);
        },
        handleInput(data: string) {
          screen.handleInput(data);
        },
        invalidate() {
          // no-op
        },
      } as Component;
    });
  }
}
