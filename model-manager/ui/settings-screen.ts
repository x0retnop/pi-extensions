import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { CycleHotkeysPreset, ModelManagerConfig } from "../types.js";
import { CYCLE_HOTKEYS_PRESETS } from "../config.js";
import { readPiDefault } from "../pi-default.js";
import { loadRoleSwitcherSettings } from "../../role-sw/config.js";
import { RoleMapScreen } from "./role-map-screen.js";
import { DefaultModelScreen } from "./default-model-screen.js";

const CYCLE_HOTKEYS_LABELS: Record<CycleHotkeysPreset, string> = {
  "ctrl+f2": "Ctrl+F2/F3",
  f2: "F2/F3",
  "ctrl+shift+arrows": "Ctrl+Shift+↑/↓",
  disabled: "disabled",
};

interface SettingRow {
  id: string;
  label: string;
  values: string[];
  currentIndex: number;
  displayValue?: string;
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
  private subview?: RoleMapScreen;
  private defaultModelView?: DefaultModelScreen;

  constructor(
    tui: TUI,
    theme: Theme,
    private kb: KeybindingsManager,
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

  invalidate(): void {
    this.subview?.invalidate();
    this.defaultModelView?.invalidate();
  }

  render(width: number): string[] {
    if (this.subview) {
      return this.subview.render(width);
    }
    if (this.defaultModelView) {
      return this.defaultModelView.render(width);
    }
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
      const value = this.theme.fg("accent", row.displayValue ?? row.values[row.currentIndex]);
      lines.push(`${prefix}${label}: ${value}`.slice(0, width));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "↑↓ move • Enter toggle • Esc back"));
    return lines;
  }

  handleInput(data: string): void {
    if (this.subview) {
      this.subview.handleInput(data);
      return;
    }
    if (this.defaultModelView) {
      this.defaultModelView.handleInput(data);
      return;
    }
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

    if (row.id === "roleMap") {
      this.subview = new RoleMapScreen(
        this.tui,
        this.theme,
        this.kb,
        this.ctx,
        this.config,
        () => {
          this.subview = undefined;
          this.rebuildRows();
          this.tui.requestRender();
        },
      );
      this.tui.requestRender();
      return;
    }

    if (row.id === "defaultModel") {
      this.defaultModelView = new DefaultModelScreen(
        this.tui,
        this.theme,
        this.kb,
        this.ctx,
        this.config,
        () => {
          this.defaultModelView = undefined;
          this.rebuildRows();
          this.tui.requestRender();
        },
      );
      this.tui.requestRender();
      return;
    }

    row.currentIndex = (row.currentIndex + 1) % row.values.length;
    const value = row.values[row.currentIndex];
    if (row.id === "rememberLastUsed") {
      this.config.global.rememberLastUsed = value === "on";
    } else if (row.id === "displaySpecs") {
      this.config.global.displaySpecs = value === "on";
    } else if (row.id === "hideGrokThinking") {
      this.config.global.hideGrokThinking = value === "hidden";
    } else if (row.id === "cycleHotkeys") {
      const preset = value as CycleHotkeysPreset;
      this.config.global.cycleHotkeys = preset;
      row.displayValue = CYCLE_HOTKEYS_LABELS[preset];
      // Parent onChange persists + notifies "Settings saved"; extra note for hotkeys.
      this.ctx.ui.notify("Cycle hotkeys change needs /reload to take effect", "info");
    }
    this.onChange(this.config);
  }

  private rebuildRows(): void {
    const roleSettings = loadRoleSwitcherSettings();
    const mappedCount = Object.keys(roleSettings.modelRoleMap).length;
    const currentPreset = this.config.global.cycleHotkeys;
    const piDefault = readPiDefault();

    this.rows = [
      {
        id: "defaultModel",
        label: "Default model (Pi startup)",
        values: ["configure"],
        currentIndex: 0,
        displayValue: piDefault ? `${piDefault.provider}/${piDefault.modelId}` : "(Pi built-in)",
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
      {
        id: "hideGrokThinking",
        label: "Grok 4.5+ thinking summary",
        values: ["hidden", "shown"],
        currentIndex: this.config.global.hideGrokThinking ? 0 : 1,
      },
      {
        id: "cycleHotkeys",
        label: "Favorite model cycle hotkeys",
        values: CYCLE_HOTKEYS_PRESETS,
        currentIndex: Math.max(0, CYCLE_HOTKEYS_PRESETS.indexOf(currentPreset)),
        displayValue: CYCLE_HOTKEYS_LABELS[currentPreset],
      },
      {
        id: "roleMap",
        label: "Model → role mappings",
        values: ["configure"],
        currentIndex: 0,
        displayValue: `${mappedCount} mapping${mappedCount === 1 ? "" : "s"}`,
      },
    ];
  }
}
