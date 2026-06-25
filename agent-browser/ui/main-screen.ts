import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentBrowserState, BrowserToolToggleKey } from "../types.js";
import { BROWSER_TOOLS, TOOL_LABELS, TOOL_HINTS } from "../types.js";

export type MainScreenAction =
  | { type: "toggle"; key: BrowserToolToggleKey }
  | { type: "save"; state: AgentBrowserState }
  | { type: "close" };

export class MainScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private state: AgentBrowserState;
  private onAction: (action: MainScreenAction) => void;
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    state: AgentBrowserState,
    onAction: (action: MainScreenAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.state = state;
    this.onAction = onAction;
  }

  refresh(state: AgentBrowserState): void {
    this.state = state;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Browser Tools") + this.theme.fg("dim", "  /browser")));
    lines.push("");
    lines.push(this.theme.fg("dim", "Select the tool groups the agent may use:"));
    lines.push("");

    for (let i = 0; i < BROWSER_TOOLS.length; i++) {
      lines.push(this.renderRow(BROWSER_TOOLS[i], i === this.selectedIndex, width));
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", "Space toggle · ↑↓ move · q save & quit · Esc close (discard)"),
        width,
      ),
    );
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (data === " ") {
      this.toggleCurrent();
    } else if (data === "q" || data === "Q") {
      this.onAction({ type: "save", state: this.state });
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.onAction({ type: "close" });
    }
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const next = this.selectedIndex + delta;
    if (next >= 0 && next < BROWSER_TOOLS.length) {
      this.selectedIndex = next;
    }
  }

  private toggleCurrent(): void {
    const key = BROWSER_TOOLS[this.selectedIndex];
    if (!key) return;
    this.state.enabled[key] = !this.state.enabled[key];
    this.onAction({ type: "toggle", key });
  }

  private renderRow(key: BrowserToolToggleKey, selected: boolean, width: number): string {
    const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
    const checked = this.state.enabled[key]
      ? this.theme.fg("success", "[x]")
      : this.theme.fg("dim", "[ ]");
    const label = this.theme.bold(TOOL_LABELS[key]);
    const hint = this.theme.fg("dim", TOOL_HINTS[key]);
    const line = `${prefix}${checked} ${label} — ${hint}`;
    return truncateToWidth(line, width);
  }
}
