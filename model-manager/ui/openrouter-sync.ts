import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { fetchOpenRouterModels } from "../openrouter.js";
import type { OpenRouterModel } from "../openrouter.js";
import { CheckboxList, type CheckboxItem } from "./components.js";
import { truncateToWidth } from "@earendil-works/pi-tui";

export class OpenRouterSyncScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private onDone: (selectedIds: string[], models: OpenRouterModel[]) => void;
  private onCancel: () => void;
  private state: { type: "loading" } | { type: "error"; message: string } | { type: "list"; list: CheckboxList; models: OpenRouterModel[] } = {
    type: "loading",
  };

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    onDone: (selectedIds: string[], models: OpenRouterModel[]) => void,
    onCancel: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.load();
  }

  private async load(): Promise<void> {
    const auth = this.ctx.modelRegistry.authStorage.get("openrouter");
    const apiKey = auth?.type === "api_key" ? auth.key : process.env.OPENROUTER_API_KEY;
    try {
      const models = await fetchOpenRouterModels(apiKey);
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
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Sync OpenRouter")), width));
    lines.push("");
    if (this.state.type === "loading") {
      lines.push(this.theme.fg("dim", "  Fetching models from OpenRouter..."));
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
