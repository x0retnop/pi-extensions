/**
 * keybinds — TUI editor for ~/.pi/agent/keybindings.json
 *
 * /keys  (alias /keybindings)
 * Live apply via the running KeybindingsManager. No /reload needed.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openKeybindsEditor } from "./tui.js";

export default function (pi: ExtensionAPI) {
  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("keybinds: TUI only — run /keys in interactive Pi", "warning");
      return;
    }
    await openKeybindsEditor(ctx);
  };

  pi.registerCommand("keys", {
    description: "Edit keybindings (view / rebind / disable)",
    handler,
  });
  pi.registerCommand("keybindings", {
    description: "Alias for /keys",
    handler,
  });
}
