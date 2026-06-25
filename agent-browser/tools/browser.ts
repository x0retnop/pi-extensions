import { spawn } from "node:child_process";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runAgentBrowser, parseWaitOption, sanitizeSelector, extraArgsToStrings } from "../utils.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const Actions = StringEnum(
  [
    "open",
    "snapshot",
    "click",
    "fill",
    "type",
    "eval",
    "screenshot",
    "close",
    "back",
    "forward",
    "reload",
    "wait",
  ],
  { description: "Browser action to perform" },
);

export const browserToolDefinition = {
  name: "browser",
  label: "Browser",
  description:
    "Core browser automation via agent-browser. Open pages, take accessibility snapshots, " +
    "click/fill/type elements, evaluate JS, take screenshots, and manage the session. " +
    "Always start with open or snapshot; snapshot -i after every page change because refs go stale.",
  promptGuidelines: [
    "Start with open(url) or snapshot.",
    "Use snapshot with interactive:true to discover @eN refs.",
    "After navigation or click, snapshot again — refs become stale.",
    "Prefer @eN refs over CSS selectors.",
    "Always close when done to free the session.",
  ],
  parameters: Type.Object({
    action: Actions,
    url: Type.Optional(Type.String({ description: "URL for open" })),
    selector: Type.Optional(Type.String({ description: "CSS selector or @eN ref for click/fill/type" })),
    text: Type.Optional(Type.String({ description: "Text for fill/type/eval" })),
    interactive: Type.Optional(Type.Boolean({ description: "snapshot: show only interactive elements (default true)" })),
    headed: Type.Optional(Type.Boolean({ description: "Show browser window (default false/headless)" })),
    session: Type.Optional(Type.String({ description: "Isolated session name" })),
    screenshot_path: Type.Optional(Type.String({ description: "Path to save screenshot" })),
    wait: Type.Optional(
      Type.String({
        description:
          "Wait target: ms number, selector/ref, text, url glob, networkidle/domcontentloaded/load, or JS expression",
      }),
    ),
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
    if (params.headed === true) extra.push("--headed");

    let result: { ok: boolean; output: string; error?: string };

    switch (action) {
      case "open": {
        if (!params.url) return errorResult("open requires url");
        result = await runAgentBrowser(["open", String(params.url), ...extra], session);
        break;
      }
      case "snapshot": {
        const args = ["snapshot"];
        if (params.interactive !== false) args.push("-i");
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "click":
      case "fill":
      case "type": {
        if (!params.selector) return errorResult(`${action} requires selector`);
        const sel = sanitizeSelector(String(params.selector));
        if (action === "click") {
          result = await runAgentBrowser(["click", sel, ...extra], session);
        } else {
          if (params.text === undefined) return errorResult(`${action} requires text`);
          result = await runAgentBrowser([action, sel, String(params.text), ...extra], session);
        }
        break;
      }
      case "eval": {
        if (params.text === undefined) return errorResult("eval requires text");
        const code = String(params.text);
        result = await runAgentBrowserEval(code, session, extra);
        break;
      }
      case "screenshot": {
        const args = ["screenshot"];
        if (params.screenshot_path) args.push(String(params.screenshot_path));
        args.push(...extra);
        result = await runAgentBrowser(args, session);
        break;
      }
      case "close": {
        result = await runAgentBrowser(["close", ...extra], session);
        break;
      }
      case "back":
      case "forward":
      case "reload": {
        result = await runAgentBrowser([action, ...extra], session);
        break;
      }
      case "wait": {
        if (!params.wait) return errorResult("wait requires wait parameter");
        result = await runAgentBrowser(parseWaitOption(String(params.wait)).concat(extra), session);
        break;
      }
      default:
        return errorResult(`Unknown action: ${action}`);
    }

    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: result.error || "Browser command failed" }],
        details: { error: result.error },
      };
    }
    return {
      content: [{ type: "text" as const, text: result.output || "Done" }],
      details: {},
    };
  },
};

async function runAgentBrowserEval(
  code: string,
  session: string | undefined,
  extra: string[],
): Promise<{ ok: boolean; output: string; error?: string }> {
  const fullArgs: string[] = [];
  if (session) fullArgs.push("--session", session);
  fullArgs.push("eval", "--stdin", ...extra, "--json");

  return new Promise((resolve) => {
    const child = spawn("agent-browser", fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
    }, 60_000);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = stdout || stderr;
      if (!combined.trim()) {
        resolve({ ok: code === 0, output: "", error: code === 0 ? undefined : `exit ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(combined) as { success?: boolean; data?: unknown; error?: string };
        if (parsed.success === true) {
          resolve({ ok: true, output: JSON.stringify(parsed.data, null, 2) });
        } else {
          resolve({ ok: false, output: "", error: parsed.error || "eval error" });
        }
      } catch {
        resolve({ ok: code === 0, output: combined.trim(), error: stderr || undefined });
      }
    });
    child.stdin.write(code);
    child.stdin.end();
  });
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
  };
}
