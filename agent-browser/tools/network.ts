import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, extraArgsToStrings } from "../utils.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const Actions = StringEnum(
  ["route", "unroute", "requests", "har_start", "har_stop"],
  { description: "Network action to perform" },
);

export const networkToolDefinition = {
  name: "browser_network",
  label: "Browser Network",
  description:
    "Intercept and inspect network traffic in the active browser session. " +
    "Route/unroute URLs, list captured requests, and record HAR files.",
  promptGuidelines: [
    "Use route to mock APIs or block trackers before opening/navigating a page.",
    "Use requests to see what the page loaded.",
    "Start har_start before actions and har_stop to save the recording.",
  ],
  parameters: Type.Object({
    action: Actions,
    pattern: Type.Optional(Type.String({ description: "URL glob pattern for route/unroute/requests filter" })),
    abort: Type.Optional(Type.Boolean({ description: "Abort matching requests instead of mocking" })),
    body: Type.Optional(Type.String({ description: "JSON response body for route mock" })),
    resource_type: Type.Optional(Type.String({ description: "Comma-separated resource types for route" })),
    output_path: Type.Optional(Type.String({ description: "HAR file path for har_stop" })),
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
        result = await runAgentBrowser(args, session);
        break;
      }
      case "unroute": {
        const args = ["network", "unroute"];
        if (params.pattern) args.push(String(params.pattern));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "requests": {
        const args = ["network", "requests"];
        if (params.pattern) args.push("--filter", String(params.pattern));
        if (params.abort === true) args.push("--clear");
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "har_start": {
        result = await runAgentBrowser(["network", "har", "start", ...extra], session);
        break;
      }
      case "har_stop": {
        const args = ["network", "har", "stop"];
        if (params.output_path) args.push(String(params.output_path));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
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
