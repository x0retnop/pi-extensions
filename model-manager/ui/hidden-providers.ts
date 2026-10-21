import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { ModelManagerConfig, UiAction } from "../types.js";
import { getProviderViews } from "../provider-utils.js";

export class HiddenProvidersScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private config: ModelManagerConfig;
  private onAction: (action: UiAction) => void;
  private onBack: () => void;
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    config: ModelManagerConfig,
    onAction: (action: UiAction) => void,
    onBack: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.config = config;
    this.onAction = onAction;
    this.onBack = onBack;
  }

  invalidate(): void {
    // No internal inputs to invalidate.
  }

  refresh(config: ModelManagerConfig): void {
    this.config = config;
    const hidden = this.hiddenViews();
    if (this.selectedIndex >= hidden.length) {
      this.selectedIndex = Math.max(0, hidden.length - 1);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Hidden Providers")), width));
    lines.push("");

    const hidden = this.hiddenViews();
    if (hidden.length === 0) {
      lines.push(this.theme.fg("dim", "  No hidden providers."));
    } else {
      const maxVisible = 18;
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), hidden.length - maxVisible));
      const end = Math.min(start + maxVisible, hidden.length);
      for (let i = start; i < end; i++) {
        const view = hidden[i];
        const selected = i === this.selectedIndex;
        const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
        const name = selected ? this.theme.fg("accent", view.name) : this.theme.fg("text", view.name);
        const line = `${prefix}${name} ${this.theme.fg("dim", `(${view.managed.managedModelIds.length} managed · ${view.models.length} available)`)}`;
        lines.push(truncateToWidth(line, width));
      }
      if (start > 0 || end < hidden.length) {
        lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${hidden.length})`));
      }
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ move · Enter/h restore · Esc back"), width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const hidden = this.hiddenViews();

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = hidden.length === 0 ? 0 : (this.selectedIndex === 0 ? hidden.length - 1 : this.selectedIndex - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = hidden.length === 0 ? 0 : (this.selectedIndex === hidden.length - 1 ? 0 : this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.confirm") || data === "h" || data === "H") {
      const view = hidden[this.selectedIndex];
      if (view) {
        this.onAction({ type: "toggleHidden", providerId: view.id });
      }
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onBack();
    }
    this.tui.requestRender();
  }

  private hiddenViews() {
    return getProviderViews(this.ctx, this.config).filter((v) => v.hidden);
  }
}
