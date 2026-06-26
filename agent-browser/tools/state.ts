import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, extraArgsToStrings } from "../utils.js";
import { getLatestState, normalizeState } from "../config.js";
import { CUSTOM_STATE_TYPE } from "../types.js";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

interface RenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

function makePlainText(text: string): RenderComponent {
  return {
    render(width: number) {
      return text ? [text.length > width ? text.slice(0, width - 1) + "…" : text] : [];
    },
    invalidate() {},
  };
}

function formatStateCall(args: Record<string, unknown>, theme: Theme): RenderComponent {
  const action = String(args.action ?? "?");
  const parts: string[] = [];
  if (args.name) parts.push(`name=${String(args.name)}`);
  if (args.path) parts.push(`path=${String(args.path).slice(0, 25)}`);
  if (args.key) parts.push(`key=${String(args.key)}`);
  if (args.cdp_url) parts.push(`cdp_url=${String(args.cdp_url)}`);

  const title = theme.fg("toolTitle", theme.bold(`browser_state ${action}`));
  const detail = parts.length > 0 ? theme.fg("dim", ` • ${parts.join(" · ")}`) : "";
  return makePlainText(`${title}${detail}`);
}

const Actions = StringEnum(
  [
    "cookies",
    "cookies_set",
    "cookies_clear",
    "storage_local",
    "storage_session",
    "state_save",
    "state_load",
  ],
  { description: "State action to perform" },
);

export function createStateToolDefinition(pi: ExtensionAPI) {
  return {
    name: "browser_state",
    label: "Browser State",
    promptSnippet: "browser_state action:cookies|cookies_set|storage_local|state_save|state_load ...",
    description:
      "Manage cookies, web storage (local/session), and saved auth state in the active browser session. " +
      "Use state_save after a login and state_load on the next run to skip re-authentication.",
    promptGuidelines: [
      "Save auth with browser_state action:state_save path:<path> after login.",
      "Restore auth with browser_state action:state_load path:<path> on the next run.",
      "Set cookies with cookies_set before opening a page when you already have a session token.",
      "Pass cdp_url on the first call; it is reused from the session afterwards.",
    ],

    renderCall(args: Record<string, unknown>, theme: Theme) {
      return formatStateCall(args, theme);
    },

    parameters: Type.Object({
      action: Actions,
      name: Type.Optional(Type.String({ description: "Cookie name" })),
      value: Type.Optional(Type.String({ description: "Cookie value" })),
      domain: Type.Optional(Type.String({ description: "Cookie domain" })),
      path: Type.Optional(Type.String({ description: "Cookie path or state file path" })),
      key: Type.Optional(Type.String({ description: "Storage key" })),
      session: Type.Optional(Type.String({ description: "Isolated session name" })),
      cdp_url: Type.Optional(Type.String({ description: "CDP URL/port of an already-running Chrome, e.g. http://127.0.0.1:9222/" })),
      extra_args: Type.Optional(Type.Array(Type.String(), { description: "Extra agent-browser CLI flags passed after the action" })),
    }),

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const action = String(params.action ?? "");
      const session = params.session ? String(params.session) : undefined;
      const explicitCdp = params.cdp_url ? String(params.cdp_url) : undefined;
      const state = getLatestState(ctx);
      const cdpUrl = explicitCdp || state.cdpUrl;
      if (explicitCdp && explicitCdp !== state.cdpUrl) {
        pi.appendEntry(CUSTOM_STATE_TYPE, normalizeState({ ...state, cdpUrl: explicitCdp }));
      }
      const extra = extraArgsToStrings(params.extra_args);

      let result: { ok: boolean; output: string; error?: string };

      switch (action) {
        case "cookies": {
          result = await runAgentBrowser(["cookies", "get", ...extra], session, cdpUrl);
          break;
        }
        case "cookies_set": {
          if (!params.name || params.value === undefined) {
            return errorResult("cookies_set requires name and value");
          }
          const args = ["cookies", "set", String(params.name), String(params.value)];
          if (params.domain) args.push("--domain", String(params.domain));
          if (params.path) args.push("--path", String(params.path));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl);
          break;
        }
        case "cookies_clear": {
          result = await runAgentBrowser(["cookies", "clear", ...extra], session, cdpUrl);
          break;
        }
        case "storage_local": {
          const args = ["storage", "local"];
          if (params.key) args.push("get", String(params.key));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl);
          break;
        }
        case "storage_session": {
          const args = ["storage", "session"];
          if (params.key) args.push("get", String(params.key));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl);
          break;
        }
        case "state_save": {
          if (!params.path) return errorResult("state_save requires path");
          result = await runAgentBrowser(["state", "save", String(params.path), ...extra], session, cdpUrl);
          break;
        }
        case "state_load": {
          if (!params.path) return errorResult("state_load requires path");
          result = await runAgentBrowser(["state", "load", String(params.path), ...extra], session, cdpUrl);
          break;
        }
        default:
          return errorResult(`Unknown action: ${action}`);
      }

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error || "State command failed" }],
          details: { error: result.error },
        };
      }
      return {
        content: [{ type: "text" as const, text: result.output || "Done" }],
        details: {},
      };
    },
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
  };
}
