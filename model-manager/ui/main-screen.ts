import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ModelManagerConfig, FavoriteItem, UiAction, ProviderView } from "../types.js";
import { getProviderViews, getDefaultModelForProvider } from "../provider-utils.js";

type Row =
  | { type: "header"; label: string }
  | { type: "favorite"; favorite: FavoriteItem; label: string; sublabel?: string }
  | { type: "provider"; view: ProviderView }
  | { type: "action"; action: UiAction; label: string };

export class MainScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private config: ModelManagerConfig;
  private onAction: (action: UiAction) => void;
  private rows: Row[] = [];
  private selectedIndex = 0;
  private searchMode = false;
  private searchInput = new Input();
  private filteredRows: Row[] = [];

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    config: ModelManagerConfig,
    onAction: (action: UiAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.config = config;
    this.onAction = onAction;
    this.rebuildRows();
  }

  refresh(config: ModelManagerConfig): void {
    this.config = config;
    this.rebuildRows();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Model Manager") + this.theme.fg("dim", "  /mm")));
    if (this.searchMode) {
      lines.push(this.theme.fg("muted", "Filter: ") + this.searchInput.render(width - 8).join(""));
    }
    lines.push("");

    const rows = this.searchMode ? this.filteredRows : this.rows;
    if (rows.length === 0) {
      lines.push(this.theme.fg("dim", "  Nothing to show."));
      return lines;
    }

    const maxVisible = 18;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), rows.length - maxVisible));
    const end = Math.min(start + maxVisible, rows.length);

    for (let i = start; i < end; i++) {
      lines.push(this.renderRow(rows[i], i === this.selectedIndex, width));
    }
    if (start > 0 || end < rows.length) {
      lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${rows.length})`));
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          "↑↓ move · Enter open/use · u use default · * favorite · / filter · ? help · Esc close",
        ),
        width,
      ),
    );
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
    if (data === "?") {
      this.onAction({ type: "help" });
      return;
    }
    if (data === "*") {
      this.toggleFavorite();
      return;
    }
    if (data === "u") {
      this.useCurrent();
      return;
    }

    const rows = this.rows;
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.activate();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onAction({ type: "close" });
    }
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const rows = this.rows;
    if (rows.length === 0) return;
    let next = this.selectedIndex + delta;
    while (next >= 0 && next < rows.length && rows[next].type === "header") {
      next += delta;
    }
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    // skip header at wrap
    while (rows[next].type === "header") {
      next = (next + 1) % rows.length;
    }
    this.selectedIndex = next;
  }

  private activate(): void {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    if (row.type === "provider") {
      this.onAction({ type: "provider", providerId: row.view.id });
    } else if (row.type === "favorite") {
      if (row.favorite.modelId) {
        this.onAction({ type: "useModel", providerId: row.favorite.providerId, modelId: row.favorite.modelId });
      } else {
        this.onAction({ type: "provider", providerId: row.favorite.providerId });
      }
    } else if (row.type === "action") {
      this.onAction(row.action);
    }
  }

  private useCurrent(): void {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    if (row.type === "favorite" && row.favorite.modelId) {
      this.onAction({ type: "useModel", providerId: row.favorite.providerId, modelId: row.favorite.modelId });
    } else if (row.type === "favorite") {
      const model = getDefaultModelForProvider(this.ctx, row.favorite.providerId);
      if (model) {
        this.onAction({ type: "useModel", providerId: model.provider, modelId: model.id });
      }
    } else if (row.type === "provider") {
      const model = getDefaultModelForProvider(this.ctx, row.view.id);
      if (model) {
        this.onAction({ type: "useModel", providerId: model.provider, modelId: model.id });
      }
    }
  }

  private toggleFavorite(): void {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    if (row.type === "favorite") {
      this.removeFavorite(row.favorite);
    } else if (row.type === "provider") {
      this.toggleProviderFavorite(row.view.id);
    }
    this.rebuildRows();
    this.tui.requestRender();
  }

  private toggleProviderFavorite(providerId: string): void {
    const idx = this.config.favorites.findIndex((f) => f.providerId === providerId && !f.modelId);
    if (idx >= 0) {
      this.config.favorites.splice(idx, 1);
    } else if (this.config.favorites.length < 10) {
      this.config.favorites.push({ providerId });
    }
  }

  private removeFavorite(fav: FavoriteItem): void {
    this.config.favorites = this.config.favorites.filter(
      (f) => !(f.providerId === fav.providerId && f.modelId === fav.modelId),
    );
  }

  private rebuildRows(): void {
    const views = getProviderViews(this.ctx, this.config.providers);
    const newRows: Row[] = [];

    // Pinned favorites
    newRows.push({ type: "header", label: "★ Pinned Favorites" });
    if (this.config.favorites.length === 0) {
      newRows.push({ type: "favorite", favorite: { providerId: "" }, label: "  (no favorites yet — press * on a provider)" });
    } else {
      for (const fav of this.config.favorites.slice(0, 10)) {
        const model = fav.modelId ? this.ctx.modelRegistry.find(fav.providerId, fav.modelId) : undefined;
        const name = model?.name ?? (fav.modelId ? `${fav.providerId}/${fav.modelId}` : this.ctx.modelRegistry.getProviderDisplayName(fav.providerId));
        const sub = model ? `${model.contextWindow.toLocaleString()} ctx · ${model.maxTokens.toLocaleString()} max` : undefined;
        newRows.push({ type: "favorite", favorite: fav, label: `[${this.theme.fg("success", "*")}] ${name}`, sublabel: sub });
      }
    }

    // Providers
    newRows.push({ type: "header", label: "Providers" });
    for (const view of views) {
      newRows.push({ type: "provider", view });
    }

    // Quick actions
    newRows.push({ type: "header", label: "Quick Actions" });
    newRows.push({ type: "action", action: { type: "addProvider" }, label: "Add new provider" });
    newRows.push({ type: "action", action: { type: "openrouter" }, label: "Sync OpenRouter models" });
    newRows.push({ type: "action", action: { type: "settings" }, label: "Global settings" });
    newRows.push({ type: "action", action: { type: "refresh" }, label: "Refresh all" });
    newRows.push({ type: "action", action: { type: "help" }, label: "Help / shortcuts" });

    this.rows = newRows;
    this.applyFilter(this.searchMode ? this.searchInput.getValue() : "");
    if (this.selectedIndex >= this.rows.length) this.selectedIndex = Math.max(0, this.rows.length - 1);
  }

  private applyFilter(query: string): void {
    if (!query) {
      this.filteredRows = this.rows;
      return;
    }
    const q = query.toLowerCase();
    this.filteredRows = this.rows.filter((r) => {
      if (r.type === "header") return true; // keep headers for context
      return this.rowLabel(r).toLowerCase().includes(q);
    });
    this.selectedIndex = 0;
    if (this.filteredRows[0]?.type === "header" && this.filteredRows.length > 1) {
      this.selectedIndex = 1;
    }
  }

  private rowLabel(row: Row): string {
    if (row.type === "header") return row.label;
    if (row.type === "favorite") return row.label;
    if (row.type === "action") return row.label;
    const v = row.view;
    const defaultModel = v.managed.useLatestDefault ? "latest" : v.managed.lastUsedModel ?? "latest";
    return `${v.name} ${v.authConfigured ? "✓" : "✗"} ${v.managed.managedModelIds.length} models default:${defaultModel}`;
  }

  private renderRow(row: Row, selected: boolean, width: number): string {
    const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
    if (row.type === "header") {
      return truncateToWidth(this.theme.fg("accent", this.theme.bold(`  ${row.label}`)), width);
    }
    if (row.type === "favorite") {
      let line = `${prefix}${row.label}`;
      if (row.sublabel) line += this.theme.fg("dim", ` — ${row.sublabel}`);
      return truncateToWidth(line, width);
    }
    if (row.type === "action") {
      return truncateToWidth(`${prefix}${this.theme.fg("accent", "→ ")}${row.label}`, width);
    }
    const v = row.view;
    const isFav = this.config.favorites.some((f) => f.providerId === v.id && !f.modelId);
    const star = isFav ? this.theme.fg("success", "[*]") : this.theme.fg("dim", "[ ]");
    const auth = v.authConfigured ? this.theme.fg("success", "●") : this.theme.fg("error", "●");
    const defaultModelRaw = v.managed.useLatestDefault ? "latest" : v.managed.lastUsedModel ?? "latest";
    const defaultModel = v.managed.useLatestDefault
      ? this.theme.fg("accent", defaultModelRaw)
      : this.theme.fg("text", defaultModelRaw);
    const rightRaw = `${v.managed.managedModelIds.length} managed · ${defaultModelRaw} · ${v.models.length} available`;
    const left = `${prefix}${star} ${auth} ${v.name}`;
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(rightRaw);
    let pad = width - leftWidth - rightWidth - 1;
    if (pad < 1) pad = 1;
    const line = left + " ".repeat(pad) + `${v.managed.managedModelIds.length} managed · ${defaultModel} · ${v.models.length} available`;
    return truncateToWidth(line, width);
  }

  private visibleWidth(text: string): number {
    // Delegates to pi-tui visibleWidth.
    return visibleWidth(text);
  }
}
