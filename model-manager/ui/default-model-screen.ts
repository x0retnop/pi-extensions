import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelManagerConfig } from "../types.js";
import { getDefaultModelForProvider } from "../provider-utils.js";
import { readPiDefault, writePiDefault } from "../pi-default.js";
import { modelRoleMapKey } from "../../role-sw/config.js";

interface DefaultOption {
  /** `undefined` = clear Pi's default and fall back to Pi's built-in choice. */
  model?: Model<any>;
  label: string;
  meta: string;
}

/**
 * Pi's startup model (`settings.json` → `defaultProvider`/`defaultModel`).
 * Subview of `/mm` → Settings — never a nested `ui.select` inside the
 * `/mm` custom UI (that leaves the outer promise pending).
 */
export class DefaultModelScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private onDone: () => void;
  private options: DefaultOption[] = [];
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    config: ModelManagerConfig,
    onDone: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.onDone = onDone;

    const current = readPiDefault();
    const options: DefaultOption[] = [
      { label: "(Pi built-in default)", meta: "no settings.json default" },
    ];
    const seen = new Set<string>();
    for (const fav of config.favorites) {
      const model = fav.modelId
        ? ctx.modelRegistry.find(fav.providerId, fav.modelId)
        : getDefaultModelForProvider(ctx, fav.providerId);
      if (!model) continue;
      const key = modelRoleMapKey(model);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({
        model,
        label: model.name ?? model.id,
        meta: `${model.provider}/${model.id}`,
      });
    }
    this.options = options;

    if (current) {
      const idx = options.findIndex((o) => o.model && o.model.provider === current.provider && o.model.id === current.modelId);
      if (idx >= 0) this.selectedIndex = idx;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Default model (Pi startup)")), width));
    lines.push(this.theme.fg("dim", "Pinned favorites only · written to settings.json · Pi applies it on new sessions"));
    lines.push("");

    if (this.options.length === 1) {
      lines.push(this.theme.fg("dim", "  No pinned favorites to pick — pin models with * in /mm"));
    }

    const current = readPiDefault();
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      const isCurrent = option.model
        ? !!current && current.provider === option.model.provider && current.modelId === option.model.id
        : !current;
      const name = selected ? this.theme.fg("accent", option.label) : this.theme.fg("text", option.label);
      const marker = isCurrent ? this.theme.fg("success", " ✓") : "";
      lines.push(truncateToWidth(`${prefix}${name}${marker} ${this.theme.fg("dim", option.meta)}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ move · Enter set startup default · Esc back"), width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.options.length === 0 ? 0 : (this.selectedIndex === 0 ? this.options.length - 1 : this.selectedIndex - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.options.length === 0 ? 0 : (this.selectedIndex === this.options.length - 1 ? 0 : this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.save();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onDone();
      return;
    }
    this.tui.requestRender();
  }

  private save(): void {
    const option = this.options[this.selectedIndex];
    if (!option) return;
    const target = option.model ? { provider: option.model.provider, modelId: option.model.id } : undefined;
    if (!writePiDefault(target)) {
      if (this.ctx.hasUI) this.ctx.ui.notify("Failed to write settings.json — default model unchanged", "error");
      return;
    }
    if (this.ctx.hasUI) {
      this.ctx.ui.notify(
        target ? `Pi startup default: ${target.provider}/${target.modelId}` : "Pi startup default cleared (built-in choice)",
        "info",
      );
    }
    this.onDone();
  }
}
