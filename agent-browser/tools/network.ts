import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, extraArgsToStrings, summarizeNetworkRequests, truncateOutput } from "../utils.js";
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

function formatNetworkCall(args: Record<string, unknown>, theme: Theme): RenderComponent {
  const action = String(args.action ?? "?");
  const parts: string[] = [];
  if (args.pattern) parts.push(`pattern=${String(args.pattern).slice(0, 35)}`);
  if (args.abort === true) parts.push("abort");
  if (args.clear === true) parts.push("clear");
  if (args.body) parts.push("body=...");
  if (args.output_path) parts.push(`out=${String(args.output_path).slice(0, 25)}`);
  if (args.cdp_url) parts.push(`cdp_url=${String(args.cdp_url)}`);

  const title = theme.fg("toolTitle", theme.bold(`browser_network ${action}`));
  const detail = parts.length > 0 ? theme.fg("dim", ` • ${parts.join(" · ")}`) : "";
  return makePlainText(`${title}${detail}`);
}

const Actions = StringEnum(
  ["route", "unroute", "requests", "har_start", "har_stop"],
  { description: "Network action to perform" },
);

export function createNetworkToolDefinition(pi: ExtensionAPI) {
  return {
    name: "browser_network",
    label: "Browser Network",
    promptSnippet: "browser_network action:route|unroute|requests|har_start|har_stop ...",
    description:
      "Intercept and inspect network traffic in the active browser session. " +
      "Route/unroute URLs, list captured requests, and record HAR files. " +
      "Set routes before opening/navigating a page to catch initial requests.",
    promptGuidelines: [
      "Set browser_network action:route before opening/navigating to catch initial requests.",
      "Use browser_network action:requests pattern:<glob> to inspect traffic. Default output is a summary; use full:true only when you need headers.",
      "Start har_start before actions and har_stop output_path:<path> to save a HAR.",
      "Pass cdp_url on the first call; it is reused from the session afterwards.",
    ],

    renderCall(args: Record<string, unknown>, theme: Theme) {
      return formatNetworkCall(args, theme);
    },

    parameters: Type.Object({
      action: Actions,
      pattern: Type.Optional(Type.String({ description: "URL glob pattern for route/unroute/requests filter" })),
      abort: Type.Optional(Type.Boolean({ description: "Abort matching requests instead of mocking" })),
      clear: Type.Optional(Type.Boolean({ description: "Clear captured requests log (requests only)" })),
      body: Type.Optional(Type.String({ description: "JSON response body for route mock" })),
      resource_type: Type.Optional(Type.String({ description: "Comma-separated resource types for route" })),
      output_path: Type.Optional(Type.String({ description: "HAR file path for har_stop" })),
      session: Type.Optional(Type.String({ description: "Isolated session name" })),
      cdp_url: Type.Optional(Type.String({ description: "CDP URL/port of an already-running Chrome, e.g. http://127.0.0.1:9222/" })),
      full: Type.Optional(Type.Boolean({ description: "Return full request details including headers (requests only). Default false/summary." })),
      max_output_chars: Type.Optional(Type.Number({ description: "Max characters to return. Default 50000." })),
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
        case "route": {
          if (!params.pattern) return errorResult("route requires pattern");
          const args = ["network", "route", String(params.pattern)];
          if (params.abort === true) {
            args.push("--abort");
          } else if (typeof params.body === "string") {
            args.push("--body", params.body);
          }
          if (params.resource_type) args.push("--resource-type", String(params.resource_type));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl);
          break;
        }
        case "unroute": {
          const args = ["network", "unroute"];
          if (params.pattern) args.push(String(params.pattern));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl);
          break;
        }
        case "requests": {
          const args = ["network", "requests"];
          if (params.pattern) args.push("--filter", String(params.pattern));
          if (params.clear === true) args.push("--clear");
          args.push(...extra);
          const raw = await runAgentBrowser(args, session, cdpUrl);
          if (!raw.ok) {
            result = raw;
            break;
          }
          const full = params.full === true;
          const maxItems = params.pattern ? 200 : 50;
          const maxChars = typeof params.max_output_chars === "number" ? params.max_output_chars : 50_000;
          result = {
            ok: true,
            output: truncateOutput(
              summarizeNetworkRequests(raw.output, maxItems, full),
              maxChars,
              "use full:true or max_output_chars:<n> for more",
            ),
          };
          break;
        }
        case "har_start": {
          result = await runAgentBrowser(["network", "har", "start", ...extra], session, cdpUrl);
          break;
        }
        case "har_stop": {
          const args = ["network", "har", "stop"];
          if (params.output_path) args.push(String(params.output_path));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl);
          break;
        }
        default:
          return errorResult(`Unknown action: ${action}`);
      }

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error || "Network command failed" }],
          details: { error: result.error },
        };
      }
      return {
        content: [{ type: "text" as const, text: truncateOutput(result.output || "Done", typeof params.max_output_chars === "number" ? params.max_output_chars : 50_000) }],
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
