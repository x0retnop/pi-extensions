import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { CheckboxList, type CheckboxItem } from "./components.js";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface SyncModel {
  id: string;
  name?: string;
  description?: string;
}

export class ProviderSyncScreen<T extends SyncModel> {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private title: string;
  private fetchModels: () => Promise<T[]>;
  private onDone: (selectedIds: string[], models: T[]) => void;
  private onCancel: () => void;
  private state: { type: "loading" } | { type: "error"; message: string } | { type: "list"; list: CheckboxList; models: T[] } = {
    type: "loading",
  };

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    title: string,
    fetchModels: () => Promise<T[]>,
    onDone: (selectedIds: string[], models: T[]) => void,
    onCancel: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.title = title;
    this.fetchModels = fetchModels;
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.load();
  }

  private async load(): Promise<void> {
    try {
      const models = await this.fetchModels();
      const items: CheckboxItem[] = models.map((m) => ({
        id: m.id,
        label: m.name ? `${m.name} (${m.id})` : m.id,
        description: m.description,
        checked: false,
      }));
      const list = new CheckboxList(this.tui, this.theme, items, 18, { search: true });
      list.onConfirm = () => {
        const selected = items.filter((i) => i.checked).map((i) => i.id);
        this.onDone(selected, models);
      };
      list.onCancel = () => this.onCancel();
      this.state = { type: "list", list, models };
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
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Model Manager > ${this.title}`)), width));
    lines.push("");
    if (this.state.type === "loading") {
      lines.push(this.theme.fg("dim", `  Fetching models from ${this.title}...`));
    } else if (this.state.type === "error") {
      lines.push(this.theme.fg("error", `  Error: ${this.state.message}`));
      lines.push("");
      lines.push(this.theme.fg("dim", "  Press Esc to go back."));
    } else {
      lines.push(...this.state.list.render(width));
      lines.push("");
      lines.push(truncateToWidth(this.theme.fg("dim", "Space toggle · a all/none · Enter confirm · Esc cancel"), width));
    }
    return lines;
  }

  handleInput(data: string): void {
    if (this.state.type === "list") {
      this.state.list.handleInput(data);
    } else if (this.state.type === "error") {
      this.onCancel();
    }
  }
}
