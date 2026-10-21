import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { CheckboxList, type CheckboxItem } from "./components.js";

export interface SyncModel {
  id: string;
  name?: string;
  description?: string;
}

export class ProviderSyncScreen<T extends SyncModel> {
  private tui: TUI;
  private theme: Theme;
  private title: string;
  private fetchModels: () => Promise<T[]>;
  private initialSelectedIds: Set<string>;
  private onDone: (selectedIds: string[], models: T[]) => void;
  private onCancel: () => void;
  private state:
    | { type: "loading" }
    | { type: "error"; message: string }
    | { type: "list"; list: CheckboxList; models: T[] } = { type: "loading" };

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    _ctx: ExtensionContext | ExtensionCommandContext,
    title: string,
    fetchModels: () => Promise<T[]>,
    onDone: (selectedIds: string[], models: T[]) => void,
    onCancel: () => void,
    initialSelectedIds: string[] = [],
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.fetchModels = fetchModels;
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.initialSelectedIds = new Set(initialSelectedIds);
    this.load();
  }

  private async load(): Promise<void> {
    try {
      const models = await this.fetchModels();
      const items: CheckboxItem[] = models.map((m) => ({
        id: m.id,
        label: m.name ? `${m.name} (${m.id})` : m.id,
        description: m.description,
        checked: this.initialSelectedIds.has(m.id),
      }));
      const list = new CheckboxList(this.tui, this.theme, items, 18, { search: true });
      list.onConfirm = () => {
        const selected = list.items.filter((i) => i.checked).map((i) => i.id);
        this.onDone(selected, models);
      };
      list.onCancel = () => this.onCancel();
      this.state = { type: "list", list, models };
      // Jump to first already-selected model when re-syncing.
      if (this.initialSelectedIds.size > 0) {
        const firstChecked = items.findIndex((i) => i.checked);
        if (firstChecked >= 0) list.selectedIndex = firstChecked;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state = { type: "error", message: msg };
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    if (this.state.type === "list") this.state.list.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Model Manager > Sync ${this.title}`)), width));
    lines.push("");
    if (this.state.type === "loading") {
      lines.push(this.theme.fg("dim", `  Fetching models from ${this.title}...`));
      lines.push("");
      lines.push(this.theme.fg("dim", "  Esc cancel"));
    } else if (this.state.type === "error") {
      lines.push(this.theme.fg("error", `  Error: ${this.state.message}`));
      lines.push("");
      lines.push(this.theme.fg("dim", "  Press Esc to go back."));
    } else {
      const checked = this.state.list.items.filter((i) => i.checked).length;
      lines.push(
        this.theme.fg(
          "muted",
          `  ${checked} selected · ${this.state.list.items.length} total · Enter saves curation (0 = disable)`,
        ),
      );
      lines.push("");
      lines.push(...this.state.list.render(width));
      lines.push("");
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", "Space toggle · a all/none (filtered) · / filter · Enter confirm · Esc cancel"),
          width,
        ),
      );
    }
    return lines;
  }

  handleInput(data: string): void {
    if (this.state.type === "list") {
      this.state.list.handleInput(data);
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onCancel();
    }
  }
}
