import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, extraArgsToStrings } from "../utils.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const Actions = StringEnum(
  ["cdp_url", "console", "errors", "trace_start", "trace_stop", "react_tree", "react_inspect", "vitals"],
  { description: "Debug action to perform" },
);

export const debugToolDefinition = {
  name: "browser_debug",
  label: "Browser Debug",
  description:
    "Debug the active browser session: read console/errors, capture Chrome DevTools traces, " +
    "inspect React trees, and measure Core Web Vitals. React commands require --enable react-devtools.",
  promptGuidelines: [
    "Use console and errors after page interactions to catch frontend issues.",
    "Start trace_start before reproducing a bug, then trace_stop to save it.",
    "React commands need the page opened with --enable react-devtools (pass via extra_args).",
  ],
  parameters: Type.Object({
    action: Actions,
    fiber_id: Type.Optional(Type.String({ description: "React fiber id for react_inspect" })),
    url: Type.Optional(Type.String({ description: "URL for vitals (uses active tab if omitted)" })),
    output_path: Type.Optional(Type.String({ description: "Trace file path for trace_stop" })),
    session: Type.Optional(Type.String({ description: "Isolated session name" })),
    extra_args: Type.Optional(Type.Array(Type.String(), { description: "Extra agent-browser CLI flags" })),
  }),

  async execute(
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ) {
    const action = String(params.action ?? "");
    const session = params.session ? String(params.session) : undefined;
    const extra = extraArgsToStrings(params.extra_args);

    let result: { ok: boolean; output: string; error?: string };

    switch (action) {
      case "cdp_url": {
        result = await runAgentBrowser(["get", "cdp-url", ...extra], session);
        break;
      }
      case "console": {
        result = await runAgentBrowser(["console", ...extra], session);
        break;
      }
      case "errors": {
        result = await runAgentBrowser(["errors", ...extra], session);
        break;
      }
      case "trace_start": {
        result = await runAgentBrowser(["trace", "start", ...extra], session);
        break;
      }
      case "trace_stop": {
        const args = ["trace", "stop"];
        if (params.output_path) args.push(String(params.output_path));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "react_tree": {
        result = await runAgentBrowser(["react", "tree", ...extra], session);
        break;
      }
      case "react_inspect": {
        if (!params.fiber_id) return errorResult("react_inspect requires fiber_id");
        result = await runAgentBrowser(["react", "inspect", String(params.fiber_id), ...extra], session);
        break;
      }
      case "vitals": {
        const args = ["vitals"];
        if (params.url) args.push(String(params.url));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
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
    return {
      content: [{ type: "text" as const, text: result.output || "Done" }],
      details: {},
    };
  },
};

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
  };
}
