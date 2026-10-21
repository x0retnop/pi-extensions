import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadShellSettings } from "./config.js";
import { createBashCallComponent } from "./bash-render.js";

let currentCwd = process.cwd();

export function setBashCwd(cwd: string): void {
  currentCwd = cwd;
}

function loadShellOptions() {
  const shellSettings = loadShellSettings();
  return {
    shellPath: shellSettings.shellPath,
    commandPrefix: shellSettings.shellCommandPrefix,
    spawnHook: (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
      ...ctx,
      cwd: currentCwd,
    }),
  };
}

export function registerBashOverride(pi: ExtensionAPI) {
  const originalBash = createBashToolDefinition(currentCwd, loadShellOptions());

  pi.registerTool({
    name: "bash",
    label: "bash",

    // Minimal on purpose: cwd semantics, the Git Bash environment and when to prefer this tool over
    // pwsh/py/grep all live in the role prompts (`docs/decisions.md` §D6), and a tool description that
    // repeats role policy only costs prefix tokens on every request.
    description: "Execute a bash command. Returns stdout and stderr.",

    parameters: Type.Object({
      command: Type.String({
        description: "Bash command to execute.",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)." })),
    }),

    renderCall(args, theme, context) {
      return createBashCallComponent(args, theme, context);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return originalBash.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
