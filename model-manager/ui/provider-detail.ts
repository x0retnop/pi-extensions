import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { ManagedProvider, ModelManagerConfig, FavoriteItem } from "../types.js";
import { getProviderModels, isCuratableProvider } from "../provider-utils.js";
import { loadModelNotes, getModelNote, type ModelNotes } from "../model-notes.js";
import { wrapLines } from "./components.js";

type DetailRow =
  | { type: "sync" }
  | { type: "model"; model: Model<Api>; managed: boolean; favorite: boolean };

export class ProviderDetail {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private providerId: string;
  private config: ModelManagerConfig;
  private onChange: (updated: ManagedProvider) => void;
  private onUse?: (model: Model<Api>) => void;
  private onSync?: () => void;
  private syncLabel?: string;
  private onAddModel?: () => void;
  private onToggleHidden?: () => void;
  private onBack: () => void;
  private managed: ManagedProvider;
  private modelRows: Extract<DetailRow, { type: "model" }>[] = [];
  private filteredRows: Extract<DetailRow, { type: "model" }>[] = [];
  private selectedIndex = 0;
  private searchMode = false;
  private searchInput = new Input();
  private canCurate: boolean;
  private notes: ModelNotes;

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
    syncLabel?: string,
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
    this.syncLabel = syncLabel;
    this.onAddModel = onAddModel;
    this.onUse = onUse;
    this.onToggleHidden = onToggleHidden;
    this.managed = config.providers.find((p) => p.id === providerId) ?? {
      id: providerId,
      enabled: true,
      useLatestDefault: true,
      managedModelIds: [],
    };
    this.canCurate = isCuratableProvider(providerId, this.managed);
    this.notes = loadModelNotes();
    this.loadModels();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const displayName = this.ctx.modelRegistry.getProviderDisplayName(this.providerId) || this.providerId;
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Providers > ${displayName}`)), width));
    lines.push(truncateToWidth(this.theme.fg("muted", `  provider id: ${this.providerId}`), width));

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
      lines.push(truncateToWidth(this.theme.fg("dim", "  (model curation is only available for OpenRouter, OpenCode Go and custom providers added via /mm)"), width));
    }
    lines.push("");

    const rows = this.displayRows();
    if (rows.length === 0) {
      lines.push(this.theme.fg("dim", "  No models found."));
    } else {
      const maxVisible = 16;
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), rows.length - maxVisible));
      const end = Math.min(start + maxVisible, rows.length);
      for (let i = start; i < end; i++) {
        lines.push(this.renderRow(rows[i], i === this.selectedIndex, width));
      }
      if (start > 0 || end < rows.length) {
        lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${rows.length})`));
      }
    }

    // Show id + note for the selected model.
    const selectedRow = rows[this.selectedIndex];
    if (selectedRow?.type === "model") {
      const model = selectedRow.model;
      const note = getModelNote(this.notes, this.providerId, model.id);
      if (note) {
        lines.push("");
        lines.push(truncateToWidth(this.theme.fg("muted", `  id: ${model.id}`), width));
        for (const line of wrapLines(note, width - 4)) {
          lines.push(truncateToWidth(this.theme.fg("dim", `    ${line}`), width));
        }
      } else if (model.id !== model.name) {
        lines.push("");
        lines.push(truncateToWidth(this.theme.fg("muted", `  id: ${model.id}`), width));
      }
    }

    lines.push("");
    const hints = ["↑↓ move", "Enter use/sync", "* favorite", "Esc back"];
    if (this.canCurate) hints.push("Space manage", "a all/none");
    if (this.onSync) hints.push("s sync");
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
    if ((data === "s" || data === "S") && this.onSync) {
      this.onSync();
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

    const rows = this.displayRows();
    if (rows.length === 0) {
      if (kb.matches(data, "tui.select.cancel") || data === "q") {
        this.onBack();
      }
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? rows.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === rows.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.useSelected();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onBack();
    }
    this.tui.requestRender();
  }

  private displayRows(): DetailRow[] {
    const models = this.searchMode ? this.filteredRows : this.modelRows;
    if (this.onSync) {
      return [{ type: "sync" }, ...models];
    }
    return models;
  }

  private loadModels(): void {
    const managedIds = new Set(this.managed.managedModelIds);
    const all = getProviderModels(this.ctx.modelRegistry, this.providerId);
    this.modelRows = all.map((m) => ({
      type: "model",
      model: m,
      managed: managedIds.has(m.id),
      favorite: this.isFavorite(m.id),
    }));
    this.applyFilter(this.searchMode ? this.searchInput.getValue() : "");
    if (this.displayRows().length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.displayRows().length) {
      this.selectedIndex = Math.max(0, this.displayRows().length - 1);
    }
  }

  private applyFilter(query: string): void {
    if (!query) {
      this.filteredRows = this.modelRows;
      return;
    }
    const q = query.toLowerCase();
    this.filteredRows = this.modelRows.filter((r) =>
      r.type === "model" && `${r.model.name} ${r.model.id}`.toLowerCase().includes(q),
    );
    this.selectedIndex = 0;
  }

  private renderRow(row: DetailRow, selected: boolean, width: number): string {
    const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
    if (row.type === "sync") {
      const label = selected ? this.theme.fg("accent", `→ Sync ${this.syncLabel ?? "provider"} models`) : this.theme.fg("text", `→ Sync ${this.syncLabel ?? "provider"} models`);
      return truncateToWidth(`${prefix}${label}`, width);
    }
    const managed = row.managed ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
    const star = row.favorite ? this.theme.fg("success", "*") : this.theme.fg("dim", " ");
    const name = selected ? this.theme.fg("accent", row.model.name) : this.theme.fg("text", row.model.name);
    const noteMark = this.notes.byProvider.has(this.providerId) && this.notes.byProvider.get(this.providerId)!.has(row.model.id)
      ? this.theme.fg("accent", " (!)")
      : getModelNote(this.notes, this.providerId, row.model.id)
        ? this.theme.fg("dim", " (!)")
        : "";
    const specs = this.config.global.displaySpecs
      ? this.theme.fg("dim", `  ${row.model.contextWindow.toLocaleString()} ctx · ${row.model.maxTokens.toLocaleString()} max`)
      : "";
    const line = `${prefix}${managed} ${star} ${name}${noteMark}${specs}`;
    return truncateToWidth(line, width);
  }

  private useSelected(): void {
    const rows = this.displayRows();
    const row = rows[this.selectedIndex];
    if (!row) return;
    if (row.type === "sync") {
      this.onSync?.();
      return;
    }
    this.onUse?.(row.model);
  }

  private toggleManaged(): void {
    const rows = this.displayRows();
    const row = rows[this.selectedIndex];
    if (!row || row.type !== "model") return;
    row.managed = !row.managed;
    this.commitManaged();
  }

  private toggleAll(): void {
    if (this.modelRows.length === 0) return;
    const target = this.modelRows.some((r) => !r.managed);
    for (const row of this.modelRows) row.managed = target;
    this.commitManaged();
  }

  private commitManaged(): void {
    this.managed.managedModelIds = this.modelRows
      .filter((r) => r.type === "model" && r.managed)
      .map((r) => r.model.id);
    this.onChange(this.managed);
  }

  private isFavorite(modelId: string): boolean {
    return this.config.favorites.some(
      (f) => f.providerId === this.providerId && f.modelId === modelId,
    );
  }

  private toggleFavorite(): void {
    const rows = this.displayRows();
    const row = rows[this.selectedIndex];
    if (!row || row.type !== "model") return;
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
