import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  codeCallComponent,
  codeResultComponent,
  formatCodeCall,
  formatCodeResultLines,
} from "./render.js";
import {
  DEFAULT_TIMEOUT_SEC,
  drainSpillPaths,
  encodePwshCommand,
  formatResult,
  resolveTimeoutMs,
  runCommand,
} from "./run.js";
import {
  createRuntimeSettings,
  updateSettings,
  type AgentRunSettings,
  type HighlightMode,
} from "./settings.js";
import { syncRunTimer, type RunTimerState } from "./timer.js";

const sharedOptionalParams = {
  timeout: Type.Optional(
    Type.Number({
      description:
        `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SEC}. Set to 0 to disable the timeout.`,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the session working directory.",
    }),
  ),
  failOnError: Type.Optional(
    Type.Boolean({
      description:
        "Non-zero throws unless listed in expectedExitCodes. Default true.",
    }),
  ),
  expectedExitCodes: Type.Optional(
    Type.Array(
      Type.Integer({ minimum: 0, maximum: 255 }),
      { description: "Also treat these codes as success. E.g. [1]." },
    ),
  ),
  max_output: Type.Optional(
    Type.Number({
      description:
        "Maximum inline output in bytes. Defaults to 10KB. Hard cap is 50KB; " +
        "larger outputs are truncated and the full output is saved to a temp file.",
    }),
  ),
};

const pwshParameters = Type.Object(
  {
    code: Type.String({
      description:
        "PowerShell 7 code.",
    }),
    ...sharedOptionalParams,
  },
  { additionalProperties: false },
);

type PwshInput = Static<typeof pwshParameters>;

const pyParameters = Type.Object(
  {
    code: Type.String({
      description:
        "Python code.",
    }),
    ...sharedOptionalParams,
  },
  { additionalProperties: false },
);

type PyInput = Static<typeof pyParameters>;

async function runConfigTui(
  ui: ExtensionUIContext,
  notify: (message: string) => void,
  settings: AgentRunSettings,
): Promise<void> {
  while (true) {
    const tool = await ui.select("Configure tool", [
      "PowerShell (pwsh)",
      "Python (py)",
      "Done",
    ]);

    if (tool !== "PowerShell (pwsh)" && tool !== "Python (py)") {
      notify("Settings saved.");
      return;
    }

    const toolKey: "pwsh" | "py" = tool === "PowerShell (pwsh)" ? "pwsh" : "py";
    const current = settings[toolKey];

    const action = await ui.select(`${toolKey} settings`, [
      `Preview lines: ${current.previewLines}`,
      `Syntax highlighting: ${current.highlight ? "on" : "off"}`,
      `Highlight mode: ${current.highlightMode}`,
      "Back",
    ]);

    if (action === `Preview lines: ${current.previewLines}`) {
      const input = await ui.input(
        "Preview lines (1-50)",
        String(current.previewLines),
      );
      const value = input ? Number(input) : NaN;
      if (Number.isFinite(value) && value >= 1 && value <= 50) {
        settings = updateSettings(settings, toolKey, { previewLines: value });
      }
    } else if (
      action === `Syntax highlighting: ${current.highlight ? "on" : "off"}`
    ) {
      settings = updateSettings(settings, toolKey, {
        highlight: !current.highlight,
      });
    } else if (action === `Highlight mode: ${current.highlightMode}`) {
      const mode = await ui.select("Highlight mode", [
        "auto",
        "powershell",
        "python",
        "none",
      ]);
      if (
        mode === "auto" ||
        mode === "powershell" ||
        mode === "python" ||
        mode === "none"
      ) {
        settings = updateSettings(settings, toolKey, {
          highlightMode: mode as HighlightMode,
        });
      }
    }
  }
}

interface CodeRowContext {
  toolCallId: string;
  /** Per-row state object handed to every render of this row (see timer.ts). */
  state: { runTimer?: RunTimerState };
  executionStarted: boolean;
  isPartial: boolean;
  expanded: boolean;
  invalidate: () => void;
  lastComponent?: unknown;
}

function renderCodeToolCall(
  tool: "pwsh" | "py",
  args: { code?: string; timeout?: number },
  theme: Parameters<typeof formatCodeCall>[4],
  context: CodeRowContext,
  toolSettings: AgentRunSettings["pwsh"],
): ReturnType<typeof codeCallComponent> {
  const timer = (context.state.runTimer ??= {});
  const elapsedMs = syncRunTimer(timer, {
    executionStarted: context.executionStarted,
    isPartial: context.isPartial,
    invalidate: context.invalidate,
  });

  return codeCallComponent(
    formatCodeCall(
      tool,
      args.code ?? "",
      toolSettings,
      args.timeout,
      theme,
      elapsedMs,
      { expanded: context.expanded },
    ),
    context,
  );
}

function renderCodeToolResult(
  result: { content?: Array<{ type?: string; text?: string }> },
  theme: Parameters<typeof formatCodeCall>[4],
  context: { expanded: boolean; lastComponent?: unknown },
  toolSettings: AgentRunSettings["pwsh"],
): ReturnType<typeof codeResultComponent> {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return codeResultComponent(
    formatCodeResultLines(text, toolSettings, theme, { expanded: context.expanded }),
    context,
  );
}

export default function (pi: ExtensionAPI) {
  const settings = createRuntimeSettings();

  // Drop spill files left over from the previous session in long-lived processes.
  pi.on("session_start", async () => {
    await drainSpillPaths();
  });

  const isSubagentChild = process.env.PI_SUB_AGENTS_CHILD === "1";

  if (!isSubagentChild) {
    pi.registerCommand("agent-run", {
      description: "Configure pi-agent-run rendering settings.",
      handler: async (_args, ctx: ExtensionCommandContext) => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          await ctx.ui.notify("agent-run requires TUI mode.", "warning");
          return;
        }
        await runConfigTui(
          ctx.ui,
          (message) => {
            ctx.ui.notify(message, "info");
          },
          settings,
        );
      },
    });
  }

  pi.registerTool({
    name: "pwsh",
    label: "PowerShell 7",
    description:
      "PowerShell 7. Chain with `;`, not `&&`.",
    parameters: pwshParameters,
    renderCall(args, theme, context) {
      return renderCodeToolCall("pwsh", args, theme, context, settings.pwsh);
    },
    renderResult(result, _options, theme, context) {
      return renderCodeToolResult(result, theme, context, settings.pwsh);
    },
    async execute(_toolCallId, params: PwshInput, signal) {
      const timeoutMs = resolveTimeoutMs(params.timeout);
      const result = await runCommand(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-OutputFormat",
          "Text",
          "-EncodedCommand",
          encodePwshCommand(params.code),
        ],
        { timeoutMs, cwd: params.cwd, signal },
      );
      return await formatResult(
        result,
        params.max_output,
        params.timeout,
        params.failOnError,
        params.expectedExitCodes,
      );
    },
  });

  pi.registerTool({
    name: "py",
    label: "Python",
    description:
      "Run Python.",
    parameters: pyParameters,
    renderCall(args, theme, context) {
      return renderCodeToolCall("py", args, theme, context, settings.py);
    },
    renderResult(result, _options, theme, context) {
      return renderCodeToolResult(result, theme, context, settings.py);
    },
    async execute(_toolCallId, params: PyInput, signal) {
      const timeoutMs = resolveTimeoutMs(params.timeout);
      const result = await runCommand("python", ["-"], {
        timeoutMs,
        input: params.code,
        cwd: params.cwd,
        signal,
      });
      return await formatResult(
        result,
        params.max_output,
        params.timeout,
        params.failOnError,
        params.expectedExitCodes,
      );
    },
  });

}
