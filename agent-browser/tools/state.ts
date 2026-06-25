import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, extraArgsToStrings } from "../utils.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export const stateToolDefinition = {
  name: "browser_state",
  label: "Browser State",
  description:
    "Manage cookies, web storage (local/session), and saved auth state in the active browser session.",
  promptGuidelines: [
    "Use state_save to persist auth after login; use state_load on the next run to skip login.",
    "Cookies and storage actions inspect or mutate the current page's state.",
  ],
  parameters: Type.Object({
    action: Actions,
    name: Type.Optional(Type.String({ description: "Cookie name" })),
    value: Type.Optional(Type.String({ description: "Cookie value" })),
    domain: Type.Optional(Type.String({ description: "Cookie domain" })),
    path: Type.Optional(Type.String({ description: "Cookie path or state file path" })),
    key: Type.Optional(Type.String({ description: "Storage key" })),
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
      case "cookies": {
        result = await runAgentBrowser(["cookies", "get", ...extra], session);
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
        result = await runAgentBrowser(args, session);
        break;
      }
      case "cookies_clear": {
        result = await runAgentBrowser(["cookies", "clear", ...extra], session);
        break;
      }
      case "storage_local": {
        const args = ["storage", "local"];
        if (params.key) args.push("get", String(params.key));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "storage_session": {
        const args = ["storage", "session"];
        if (params.key) args.push("get", String(params.key));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "state_save": {
        if (!params.path) return errorResult("state_save requires path");
        result = await runAgentBrowser(["state", "save", String(params.path), ...extra], session);
        break;
      }
      case "state_load": {
        if (!params.path) return errorResult("state_load requires path");
        result = await runAgentBrowser(["state", "load", String(params.path), ...extra], session);
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

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
  };
}
