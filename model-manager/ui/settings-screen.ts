import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { ModelManagerConfig } from "../types.js";
import { getProviderViews } from "../provider-utils.js";

interface SettingRow {
  id: string;
  label: string;
  values: string[];
  currentIndex: number;
}

export class SettingsScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private config: ModelManagerConfig;
  private onChange: (config: ModelManagerConfig) => void;
  private onBack: () => void;
  private rows: SettingRow[] = [];
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    config: ModelManagerConfig,
    onChange: (config: ModelManagerConfig) => void,
    onBack: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.config = config;
    this.onChange = onChange;
    this.onBack = onBack;
    this.rebuildRows();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Settings")), width));
    lines.push("");
    if (this.rows.length === 0) {
      lines.push(this.theme.fg("dim", "  No settings available."));
      return lines;
    }
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      const label = selected ? this.theme.fg("accent", row.label) : this.theme.fg("text", row.label);
      const value = this.theme.fg("accent", row.values[row.currentIndex]);
      lines.push(`${prefix}${label}: ${value}`.slice(0, width));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "↑↓ move • Enter toggle • Esc back"));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.rows.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === this.rows.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      this.toggle();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onBack();
    }
    this.tui.requestRender();
  }

  private toggle(): void {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    row.currentIndex = (row.currentIndex + 1) % row.values.length;
    const value = row.values[row.currentIndex];
    if (row.id === "defaultProvider") {
      this.config.global.defaultProvider = value === "(none)" ? undefined : value;
    } else if (row.id === "rememberLastUsed") {
      this.config.global.rememberLastUsed = value === "on";
    } else if (row.id === "displaySpecs") {
      this.config.global.displaySpecs = value === "on";
    }
    this.onChange(this.config);
  }

  private rebuildRows(): void {
    const providers = getProviderViews(this.ctx, this.config.providers);
    const providerOptions = ["(none)", ...providers.map((p) => p.id)];
    const currentDefault = this.config.global.defaultProvider ?? "(none)";

    this.rows = [
      {
        id: "defaultProvider",
        label: "Default provider",
        values: providerOptions,
        currentIndex: Math.max(0, providerOptions.indexOf(currentDefault)),
      },
      {
        id: "rememberLastUsed",
        label: "Remember last-used model per provider",
        values: ["on", "off"],
        currentIndex: this.config.global.rememberLastUsed ? 0 : 1,
      },
      {
        id: "displaySpecs",
        label: "Show model specs",
        values: ["on", "off"],
        currentIndex: this.config.global.displaySpecs ? 0 : 1,
      },
    ];
  }
}
