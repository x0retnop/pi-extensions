import { spawn } from "node:child_process";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  runAgentBrowser,
  parseWaitOption,
  sanitizeSelector,
  extraArgsToStrings,
  truncateOutput,
  truncateLines,
  AGENT_BROWSER_PATH,
  checkAborted,
  forceKill,
} from "../utils.js";
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

function formatBrowserCall(args: Record<string, unknown>, theme: Theme): RenderComponent {
  const action = String(args.action ?? "?");
  const parts: string[] = [];
  if (args.url) parts.push(`url=${String(args.url).slice(0, 40)}`);
  if (args.selector) parts.push(`selector=${String(args.selector).slice(0, 30)}`);
  if (args.text) parts.push(`text="${String(args.text).slice(0, 30)}"`);
  if (args.tab) parts.push(`tab=${String(args.tab)}`);
  if (args.wait_after) parts.push(`wait_after=${String(args.wait_after).slice(0, 25)}`);
  if (args.wait) parts.push(`wait=${String(args.wait).slice(0, 25)}`);
  if (args.screenshot_path) parts.push(`screenshot=${String(args.screenshot_path).slice(0, 25)}`);
  if (args.cdp_url) parts.push(`cdp_url=${String(args.cdp_url)}`);
  if (args.session) parts.push(`session=${String(args.session)}`);

  const title = theme.fg("toolTitle", theme.bold(`browser ${action}`));
  const detail = parts.length > 0 ? theme.fg("dim", ` • ${parts.join(" · ")}`) : "";
  return makePlainText(`${title}${detail}`);
}

const Actions = StringEnum(
  [
    "open",
    "snapshot",
    "click",
    "fill",
    "type",
    "eval",
    "text",
    "submit",
    "screenshot",
    "close",
    "back",
    "forward",
    "reload",
    "wait",
    "tabs",
    "tab",
  ],
  { description: "Browser action to perform" },
);

const NAVIGATION_ACTIONS = new Set(["open", "tab", "back", "forward", "reload"]);

export function createBrowserToolDefinition(pi: ExtensionAPI) {
  return {
    name: "browser",
    label: "Browser",
    promptSnippet:
      "browser action:open|snapshot|tabs|tab|click|fill|type|submit|eval|text|screenshot|close|wait ...",
    description:
      "Core browser automation via agent-browser. Open pages, take accessibility snapshots, " +
      "click/fill/type/submit elements, evaluate JS, read visible text, take screenshots, manage tabs, " +
      "and control sessions. Pass cdp_url once; it is remembered for the session.",
    promptGuidelines: [
      "Read the local skill file at agent-browser/skills/core.md before using browser tools.",
      "Use ONLY the Pi browser tools. Never run the agent-browser CLI directly from bash.",
      "The default CDP endpoint is http://127.0.0.1:9222/. Pass cdp_url only if you need a different Chrome instance. It is auto-reused afterwards.",
      "Work with the user's existing tabs (browser action:tabs / tab:<id>). Do not launch a new browser and do not close the user's browser.",
      "Use @eN refs from the snapshot for click/fill/type/submit (e.g. @e3, not [ref=e3]); they fall back to the element's text/aria-label if stale.",
      "Navigation actions (open, tab, back, forward, reload) automatically wait for networkidle unless you set wait_after:false.",
      "click, fill, type, and submit also auto-wait for networkidle after the action. This waits for the action to settle, not for a new chat/LLM response to appear.",
      "In chat/LLM interfaces, pass wait_after:\"<response-marker>\" on submit/click to wait for the model to start answering (e.g. wait_after:\"Размышление\" for Grok).",
      "After click/fill/type/submit on a dynamic page, re-snapshot before the next ref-based action.",
      "Use browser action:text to read visible page text instead of guessing selectors with eval.",
      "Use browser action:submit selector:<input> text:<message> for forms/chat inputs.",
      "Only call browser action:close for isolated session:<name> browsers you created. Never close the user's live CDP browser.",
    ],

    renderCall(args: Record<string, unknown>, theme: Theme) {
      return formatBrowserCall(args, theme);
    },

    parameters: Type.Object({
      action: Actions,
      url: Type.Optional(Type.String({ description: "URL for open" })),
      selector: Type.Optional(
        Type.String({
          description:
            "CSS selector, @eN ref, or text/label for click/fill/type/submit. " +
            "Examples: @e3, #submit, [aria-label=Send], \"Submit\", \"text=Click me\"",
        }),
      ),
      text: Type.Optional(Type.String({ description: "Text for fill/type/eval/submit" })),
      tab: Type.Optional(Type.String({ description: "Tab id or label to switch to (action:tab)" })),
      max_output_chars: Type.Optional(Type.Number({ description: "Max characters to return from text/eval/snapshot. Default depends on action." })),
      max_snapshot_lines: Type.Optional(Type.Number({ description: "Max lines to return from snapshot. Default 300." })),
      interactive: Type.Optional(Type.Boolean({ description: "snapshot: show only interactive elements (default true)" })),
      headed: Type.Optional(Type.Boolean({ description: "Show browser window (default false/headless)" })),
      session: Type.Optional(Type.String({ description: "Isolated session name" })),
      screenshot_path: Type.Optional(Type.String({ description: "Path to save screenshot" })),
      cdp_url: Type.Optional(
        Type.String({ description: "CDP URL/port of an already-running Chrome. Default: http://127.0.0.1:9222/" }),
      ),
      wait: Type.Optional(
        Type.String({
          description:
            "Wait target: ms number, selector/ref, text, url glob, networkidle/domcontentloaded/load, or JS expression",
        }),
      ),
      wait_after: Type.Optional(
        Type.String({
          description:
            "After the action completes, wait for this target (networkidle, selector/ref, text, url glob, or ms). " +
            "Set to 'false' to disable the default navigation wait. " +
            "Use after click/fill/type/submit to avoid an extra wait tool call.",
        }),
      ),
      extra_args: Type.Optional(Type.Array(Type.String(), { description: "Extra agent-browser CLI flags passed after the action" })),
    }),

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
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
      if (params.headed === true) extra.push("--headed");

      let result: { ok: boolean; output: string; error?: string };
      let snapshotOutput = "";

      switch (action) {
        case "open": {
          if (!params.url) return errorResult("open requires url");
          result = await runAgentBrowser(["open", String(params.url), ...extra], session, cdpUrl, undefined, signal);
          break;
        }
          case "snapshot": {
          const args = ["snapshot"];
          if (params.interactive !== false) args.push("-i");
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl, undefined, signal);
          if (result.ok && result.output) {
            const maxLines = typeof params.max_snapshot_lines === "number" ? params.max_snapshot_lines : 300;
            const maxChars = typeof params.max_output_chars === "number" ? params.max_output_chars : 30_000;
            snapshotOutput = truncateOutput(truncateLines(result.output, maxLines), maxChars);
            result = { ok: true, output: snapshotOutput };
          }
          break;
        }
        case "tabs": {
          result = await runAgentBrowser(["tab", ...extra], session, cdpUrl, undefined, signal);
          break;
        }
        case "tab": {
          if (!params.tab) return errorResult("tab requires tab parameter");
          result = await runAgentBrowser(["tab", String(params.tab), ...extra], session, cdpUrl, undefined, signal);
          break;
        }
        case "click":
        case "fill":
        case "type": {
          if (!params.selector) return errorResult(`${action} requires selector`);
          const sel = resolveSelector(String(params.selector), state.lastSnapshot);
          if (action === "click") {
            result = await runAgentBrowser(["click", sel, ...extra], session, cdpUrl, undefined, signal);
          } else {
            if (params.text === undefined) return errorResult(`${action} requires text`);
            result = await runAgentBrowser([action, sel, String(params.text), ...extra], session, cdpUrl, undefined, signal);
          }
          break;
        }
        case "submit": {
          if (!params.selector) return errorResult("submit requires selector (input field)");
          if (params.text === undefined) return errorResult("submit requires text");
          const inputSel = resolveSelector(String(params.selector), state.lastSnapshot);
          const fillResult = await runAgentBrowser(["fill", inputSel, String(params.text), ...extra], session, cdpUrl, undefined, signal);
          checkAborted(fillResult);
          if (!fillResult.ok) {
            result = fillResult;
            break;
          }
          const sendSel = findSendButtonSelector(state.lastSnapshot) || 'button[aria-label="Send"], button[aria-label="Отправить"]';
          result = await runAgentBrowser(["click", sendSel, ...extra], session, cdpUrl, undefined, signal);
          if (!result.ok) {
            result = await runAgentBrowser(
              ["click", 'button[type="submit"], button:has-text("Send"), button:has-text("Отправить")', ...extra],
              session,
              cdpUrl,
              undefined,
              signal,
            );
          }
          break;
        }
        case "eval": {
          if (params.text === undefined) return errorResult("eval requires text");
          const code = String(params.text);
          result = await runAgentBrowserEval(code, session, extra, cdpUrl, signal);
          if (result.ok && result.output) {
            const maxChars = typeof params.max_output_chars === "number" ? params.max_output_chars : 30_000;
            result = { ok: true, output: truncateOutput(result.output, maxChars, "use max_output_chars:<n> for more") };
          }
          break;
        }
        case "text": {
          const maxChars = typeof params.max_output_chars === "number" ? params.max_output_chars : 16_000;
          result = await runAgentBrowserEval(
            `(() => { const main = document.querySelector('main') || document.body; return main.innerText.slice(0, ${maxChars}); })()`,
            session,
            extra,
            cdpUrl,
            signal,
          );
          break;
        }
        case "screenshot": {
          const args = ["screenshot"];
          if (params.screenshot_path) args.push(String(params.screenshot_path));
          args.push(...extra);
          result = await runAgentBrowser(args, session, cdpUrl, undefined, signal);
          break;
        }
        case "close": {
          result = await runAgentBrowser(["close", ...extra], session, cdpUrl, undefined, signal);
          break;
        }
        case "back":
        case "forward":
        case "reload": {
          result = await runAgentBrowser([action, ...extra], session, cdpUrl, undefined, signal);
          break;
        }
        case "wait": {
          if (!params.wait) return errorResult("wait requires wait parameter");
          result = await runAgentBrowser(parseWaitOption(String(params.wait)).concat(extra), session, cdpUrl, undefined, signal);
          break;
        }
        default:
          return errorResult(`Unknown action: ${action}`);
      }

      checkAborted(result);

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error || "Browser command failed" }],
          details: { error: result.error },
        };
      }

      // Cache snapshot for @eN fallback. Keep it small so session state stays lean.
      if (action === "snapshot" && snapshotOutput) {
        const trimmed = snapshotOutput.length > 8_000 ? snapshotOutput.slice(0, 8_000) + "\n[TRUNCATED for state cache]" : snapshotOutput;
        pi.appendEntry(CUSTOM_STATE_TYPE, normalizeState({ ...getLatestState(ctx), lastSnapshot: trimmed }));
      }

      // Auto-wait after navigation actions by default.
      const waitAfter = inferWaitAfter(params, action);
      if (waitAfter && waitAfter !== "false") {
        const waitResult = await runAgentBrowser(parseWaitOption(waitAfter).concat(extra), session, cdpUrl, undefined, signal);
        checkAborted(waitResult);
        if (!waitResult.ok) {
          result = {
            ok: true,
            output: result.output + `\n(auto-wait '${waitAfter}' did not resolve: ${waitResult.error})`,
          };
        } else {
          result = {
            ok: true,
            output: result.output + `\n(auto-waited: ${waitAfter})`,
          };
        }
      }

      const finalMaxChars = typeof params.max_output_chars === "number" ? params.max_output_chars : 50_000;
      return {
        content: [{ type: "text" as const, text: truncateOutput(result.output || "Done", finalMaxChars) }],
        details: {},
      };
    },
  };
}

function inferWaitAfter(params: Record<string, unknown>, action: string): string | undefined {
  if (params.wait_after !== undefined) {
    const w = String(params.wait_after);
    return w === "false" ? undefined : w;
  }
  if (NAVIGATION_ACTIONS.has(action)) {
    return "networkidle";
  }
  // Interaction actions often trigger dynamic updates; give the page a chance
  // to settle before the agent reads or acts again.
  if (["click", "fill", "type", "submit"].includes(action)) {
    return "networkidle";
  }
  return undefined;
}

function resolveSelector(selector: string, lastSnapshot?: string): string {
  const trimmed = selector.trim();

  // Accept both @eN and [ref=eN] forms; agent often copies the literal [ref=eN] label.
  let ref: string | undefined;
  if (trimmed.startsWith("@")) {
    ref = trimmed.slice(1);
  } else {
    const bracketMatch = trimmed.match(/^\[ref=(e?\d+)\]$/i);
    if (bracketMatch) ref = bracketMatch[1];
  }

  if (!ref || !lastSnapshot) return sanitizeSelector(trimmed);

  const line = lastSnapshot.split("\n").find((l) => l.includes(`[ref=${ref}]`));
  if (!line) return sanitizeSelector(trimmed);

  const ariaMatch = line.match(/aria-label="([^"]+)"/);
  if (ariaMatch) return `[aria-label="${ariaMatch[1]}"]`;

  const textMatch = line.match(/"([^"]{3,})"/);
  if (textMatch) return `text=${textMatch[1]}`;

  return sanitizeSelector(trimmed);
}

function findSendButtonSelector(lastSnapshot?: string): string | undefined {
  if (!lastSnapshot) return undefined;
  const lines = lastSnapshot.split("\n");
  for (const line of lines) {
    if (/Отправить|Send/i.test(line)) {
      const ariaMatch = line.match(/aria-label="([^"]+)"/);
      if (ariaMatch) return `[aria-label="${ariaMatch[1]}"]`;
      const textMatch = line.match(/"([^"]{3,})"/);
      if (textMatch) return `text=${textMatch[1]}`;
    }
  }
  return undefined;
}

async function runAgentBrowserEval(
  code: string,
  session: string | undefined,
  extra: string[],
  cdpUrl: string | undefined,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const fullArgs: string[] = [];
  if (cdpUrl) fullArgs.push("--cdp", cdpUrl);
  if (session) fullArgs.push("--session", session);
  fullArgs.push("eval", "--stdin", ...extra, "--json");

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, output: "", error: "aborted" });
      return;
    }

    const child = spawn(AGENT_BROWSER_PATH, fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stdout += "\n[TIMEOUT: agent-browser eval did not finish within timeout; forcing termination]";
      forceKill(child);
    }, 60_000);

    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortHandler);
    }

    const abortHandler = () => {
      stdout += "\n[ABORT: agent-browser eval aborted by user]";
      forceKill(child);
    };
    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, output: "", error: err.message });
    });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) {
        resolve({ ok: false, output: stdout, error: "aborted" });
        return;
      }
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
