import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, extraArgsToStrings, truncateOutput } from "../utils.js";
import { getLatestState, normalizeState } from "../config.js";
import { CUSTOM_STATE_TYPE, DEFAULT_CDP_URL } from "../types.js";
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

function formatDebugCall(args: Record<string, unknown>, theme: Theme): RenderComponent {
  const action = String(args.action ?? "?");
  const parts: string[] = [];
  if (args.fiber_id) parts.push(`fiber=${String(args.fiber_id)}`);
  if (args.url) parts.push(`url=${String(args.url).slice(0, 35)}`);
  if (args.output_path) parts.push(`out=${String(args.output_path).slice(0, 25)}`);
  if (args.clear === true) parts.push("clear");
  if (args.cdp_url) parts.push(`cdp_url=${String(args.cdp_url)}`);

  const title = theme.fg("toolTitle", theme.bold(`browser_debug ${action}`));
  const detail = parts.length > 0 ? theme.fg("dim", ` • ${parts.join(" · ")}`) : "";
  return makePlainText(`${title}${detail}`);
}

const Actions = StringEnum(
  ["cdp_url", "console", "errors", "trace_start", "trace_stop", "react_tree", "react_inspect", "vitals"],
  { description: "Debug action to perform" },
);

export function createDebugToolDefinition(pi: ExtensionAPI) {
  return {
  name: "browser_debug",
  label: "Browser Debug",
  promptSnippet: "browser_debug action:console|errors|trace_start|trace_stop|react_tree|vitals ...",
  description:
    "Debug the active browser session: read console/errors, capture Chrome DevTools traces, " +
    "inspect React trees, and measure Core Web Vitals. React commands require --enable react-devtools.",
  promptGuidelines: [
    "Run browser_debug action:console and action:errors after page interactions to catch frontend issues.",
    "Start trace_start before reproducing a bug, then trace_stop output_path:<path> to save it.",
    "React commands need the page opened with extra_args:[\"--enable\",\"react-devtools\"].",
        "The default CDP endpoint is http://127.0.0.1:9222/. Pass cdp_url only if you need a different Chrome instance. It is auto-reused afterwards.",
  ],

  renderCall(args, theme) {
    return formatDebugCall(args as Record<string, unknown>, theme);
  },

  parameters: Type.Object({
    action: Actions,
    fiber_id: Type.Optional(Type.String({ description: "React fiber id for react_inspect" })),
    url: Type.Optional(Type.String({ description: "URL for vitals (uses active tab if omitted)" })),
    output_path: Type.Optional(Type.String({ description: "Trace file path for trace_stop" })),
    clear: Type.Optional(Type.Boolean({ description: "Clear console or error log" })),
    session: Type.Optional(Type.String({ description: "Isolated session name" })),
    cdp_url: Type.Optional(Type.String({ description: "CDP URL/port of an already-running Chrome. Default: http://127.0.0.1:9222/" })),
    max_output_chars: Type.Optional(Type.Number({ description: "Max characters to return. Default 30000." })),
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
    const cdpUrl = explicitCdp || state.cdpUrl || DEFAULT_CDP_URL;
    if (explicitCdp && explicitCdp !== state.cdpUrl) {
      pi.appendEntry(CUSTOM_STATE_TYPE, normalizeState({ ...state, cdpUrl: explicitCdp }));
    }
    const extra = extraArgsToStrings(params.extra_args);

    let result: { ok: boolean; output: string; error?: string };

    switch (action) {
      case "cdp_url": {
        result = await runAgentBrowser(["get", "cdp-url", ...extra], session, cdpUrl);
        if (result.ok && result.output) {
          const httpUrl = "http://127.0.0.1:9222/";
          result = {
            ok: true,
            output: `CDP endpoint: ${result.output.trim()}\nPass cdp_url:"${httpUrl}" to reuse the user's running Chrome.`,
          };
        }
        break;
      }
      case "console": {
        const cargs = ["console"];
        if (params.clear === true) cargs.push("--clear");
        cargs.push(...extra);
        result = await runAgentBrowser(cargs, session, cdpUrl);
        break;
      }
      case "errors": {
        const eargs = ["errors"];
        if (params.clear === true) eargs.push("--clear");
        eargs.push(...extra);
        result = await runAgentBrowser(eargs, session, cdpUrl);
        break;
      }
      case "trace_start": {
        result = await runAgentBrowser(["trace", "start", ...extra], session, cdpUrl);
        break;
      }
      case "trace_stop": {
        const args = ["trace", "stop"];
        if (params.output_path) args.push(String(params.output_path));
        args.push(...extra);
        result = await runAgentBrowser(args, session, cdpUrl);
        break;
      }
      case "react_tree": {
        result = await runAgentBrowser(["react", "tree", ...extra], session, cdpUrl);
        break;
      }
      case "react_inspect": {
        if (!params.fiber_id) return errorResult("react_inspect requires fiber_id");
        result = await runAgentBrowser(["react", "inspect", String(params.fiber_id), ...extra], session, cdpUrl);
        break;
      }
      case "vitals": {
        const args = ["vitals"];
        if (params.url) args.push(String(params.url));
        args.push(...extra);
        result = await runAgentBrowser(args, session, cdpUrl);
        break;
      }
      default:
        return errorResult(`Unknown action: ${action}`);
    }

    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: result.error || "Debug command failed" }],
        details: { error: result.error },
      };
    }
    const maxChars = typeof params.max_output_chars === "number" ? params.max_output_chars : 30_000;
    return {
      content: [{ type: "text" as const, text: truncateOutput(result.output || "Done", maxChars) }],
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
