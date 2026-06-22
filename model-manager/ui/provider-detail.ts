import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { ManagedProvider, ModelManagerConfig, FavoriteItem } from "../types.js";
import { getProviderModels, isBuiltInProvider } from "../provider-utils.js";

interface ModelRow {
  model: Model<Api>;
  managed: boolean;
  favorite: boolean;
}

export class ProviderDetail {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private providerId: string;
  private config: ModelManagerConfig;
  private onChange: (updated: ManagedProvider) => void;
  private onUse?: (model: Model<Api>) => void;
  private onSync?: () => void;
  private onAddModel?: () => void;
  private onToggleHidden?: () => void;
  private onBack: () => void;
  private managed: ManagedProvider;
  private models: ModelRow[] = [];
  private filteredModels: ModelRow[] = [];
  private selectedIndex = 0;
  private searchMode = false;
  private searchInput = new Input();
  private canCurate: boolean;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    providerId: string,
    config: ModelManagerConfig,
    onChange: (updated: ManagedProvider) => void,
    onBack: () => void,
    onSync?: () => void,
    onAddModel?: () => void,
    onUse?: (model: Model<Api>) => void,
    onToggleHidden?: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.providerId = providerId;
    this.config = config;
    this.onChange = onChange;
    this.onBack = onBack;
    this.onSync = onSync;
    this.onAddModel = onAddModel;
    this.onUse = onUse;
    this.onToggleHidden = onToggleHidden;
    this.canCurate = !isBuiltInProvider(providerId) || providerId === "openrouter";
    this.managed = config.providers.find((p) => p.id === providerId) ?? {
      id: providerId,
      enabled: true,
      useLatestDefault: true,
      managedModelIds: [],
    };
    this.loadModels();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const name = this.ctx.modelRegistry.getProviderDisplayName(this.providerId) || this.providerId;
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Providers > ${name}`)), width));

    const isHidden = this.config.global.hiddenProviderIds.includes(this.providerId);
    if (isHidden) {
      lines.push(truncateToWidth(this.theme.fg("warning", "  [hidden] press h to restore"), width));
    }

    const toggle = this.managed.useLatestDefault
      ? this.theme.fg("success", "ON")
      : this.theme.fg("dim", "OFF");
    lines.push(truncateToWidth(`  Always use newest default model: ${toggle}`, width));

    if (this.searchMode) {
      lines.push(truncateToWidth(this.theme.fg("muted", "Filter: ") + this.searchInput.render(width - 8).join(""), width));
    }
    if (!this.canCurate) {
      lines.push(truncateToWidth(this.theme.fg("dim", "  (model curation is only available for OpenRouter and custom providers)"), width));
    }
    lines.push("");

    const rows = this.searchMode ? this.filteredModels : this.models;
    if (rows.length === 0) {
      lines.push(this.theme.fg("dim", "  No models found."));
    } else {
      const maxVisible = 16;
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), rows.length - maxVisible));
      const end = Math.min(start + maxVisible, rows.length);
      for (let i = start; i < end; i++) {
        lines.push(this.renderModel(rows[i], i === this.selectedIndex, width));
      }
      if (start > 0 || end < rows.length) {
        lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${rows.length})`));
      }
    }

    lines.push("");
    const hints = ["↑↓ move", "Enter use", "* favorite", "Esc back"];
    if (this.canCurate) hints.push("Space manage", "a all/none");
    if (this.providerId === "openrouter") hints.push("s sync");
    if (this.onAddModel) hints.push("n add model");
    hints.push("h hide provider");
    if (this.searchMode) hints.push("Enter close filter");
    else hints.push("/ filter");
    lines.push(truncateToWidth(this.theme.fg("dim", hints.join(" · ")), width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (this.searchMode) {
      if (kb.matches(data, "tui.select.cancel")) {
        this.searchMode = false;
        this.searchInput.setValue("");
        this.applyFilter("");
      } else if (kb.matches(data, "tui.select.confirm")) {
        this.searchMode = false;
      } else {
        this.searchInput.handleInput(data);
        this.applyFilter(this.searchInput.getValue());
      }
      this.tui.requestRender();
      return;
    }

    if (data === "/") {
      this.searchMode = true;
      this.tui.requestRender();
      return;
    }
    if (data === "*") {
      this.toggleFavorite();
      return;
    }
    if ((data === " " || data === "x") && this.canCurate) {
      this.toggleManaged();
      return;
    }
    if (data === "u" || data === "U") {
      this.useSelected();
      return;
    }
    if ((data === "a" || data === "A") && this.canCurate) {
      this.toggleAll();
      return;
    }
    if ((data === "s" || data === "S") && this.providerId === "openrouter") {
      this.onSync?.();
      return;
    }
    if ((data === "n" || data === "N") && this.onAddModel) {
      this.onAddModel();
      return;
    }
    if (data === "h" || data === "H") {
      this.onToggleHidden?.();
      return;
    }

    if (this.models.length === 0) {
      if (kb.matches(data, "tui.select.cancel") || data === "q") {
        this.onBack();
      }
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.models.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === this.models.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.useSelected();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onBack();
    }
    this.tui.requestRender();
  }

  private loadModels(): void {
    const managedIds = new Set(this.managed.managedModelIds);
    const all = getProviderModels(this.ctx.modelRegistry, this.providerId);
    this.models = all.map((m) => ({
      model: m,
      managed: managedIds.has(m.id),
      favorite: this.isFavorite(m.id),
    }));
    this.applyFilter(this.searchMode ? this.searchInput.getValue() : "");
    if (this.models.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.models.length) {
      this.selectedIndex = Math.max(0, this.models.length - 1);
    }
  }

  private applyFilter(query: string): void {
    if (!query) {
      this.filteredModels = this.models;
      return;
    }
    const q = query.toLowerCase();
    this.filteredModels = this.models.filter((r) =>
      `${r.model.name} ${r.model.id}`.toLowerCase().includes(q),
    );
    this.selectedIndex = 0;
  }

  private renderModel(row: ModelRow, selected: boolean, width: number): string {
    const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
    const managed = row.managed ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
    const star = row.favorite ? this.theme.fg("success", "*") : this.theme.fg("dim", " ");
    const name = selected ? this.theme.fg("accent", row.model.name) : this.theme.fg("text", row.model.name);
    const specs = this.config.global.displaySpecs
      ? this.theme.fg("dim", `  ${row.model.contextWindow.toLocaleString()} ctx · ${row.model.maxTokens.toLocaleString()} max`)
      : "";
    const line = `${prefix}${managed} ${star} ${name}${specs}`;
    return truncateToWidth(line, width);
  }

  private useSelected(): void {
    const rows = this.searchMode ? this.filteredModels : this.models;
    const row = rows[this.selectedIndex];
    if (!row) return;
    this.onUse?.(row.model);
  }

  private toggleManaged(): void {
    const rows = this.searchMode ? this.filteredModels : this.models;
    const row = rows[this.selectedIndex];
    if (!row) return;
    row.managed = !row.managed;
    this.commitManaged();
  }

  private toggleAll(): void {
    if (this.models.length === 0) return;
    const target = this.models.some((r) => !r.managed);
    for (const row of this.models) row.managed = target;
    this.commitManaged();
  }

  private commitManaged(): void {
    this.managed.managedModelIds = this.models.filter((r) => r.managed).map((r) => r.model.id);
    this.onChange(this.managed);
  }

  private isFavorite(modelId: string): boolean {
    return this.config.favorites.some(
      (f) => f.providerId === this.providerId && f.modelId === modelId,
    );
  }

  private toggleFavorite(): void {
    const rows = this.searchMode ? this.filteredModels : this.models;
    const row = rows[this.selectedIndex];
    if (!row) return;
    row.favorite = !row.favorite;
    const fav: FavoriteItem = { providerId: this.providerId, modelId: row.model.id };
    if (row.favorite) {
      if (!this.config.favorites.some((f) => f.providerId === fav.providerId && f.modelId === fav.modelId)) {
        if (this.config.favorites.length < 10) {
          this.config.favorites.push(fav);
        }
      }
    } else {
      this.config.favorites = this.config.favorites.filter(
        (f) => !(f.providerId === fav.providerId && f.modelId === fav.modelId),
      );
    }
    this.onChange(this.managed);
  }
}
