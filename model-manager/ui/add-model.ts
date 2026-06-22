import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { Form, type FormField } from "./components.js";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface NewModelValues {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export class AddModelScreen {
  private tui: TUI;
  private theme: Theme;
  private form: Form;
  private onSubmit: (values: NewModelValues) => void;
  private onCancel: () => void;
  private error?: string;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    _ctx: ExtensionContext | ExtensionCommandContext,
    providerId: string,
    onSubmit: (values: NewModelValues) => void,
    onCancel: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    const fields: FormField[] = [
      { id: "id", label: "Model id", value: `${providerId}/` },
      { id: "name", label: "Display name", value: "" },
      { id: "contextWindow", label: "Context window", value: "128000" },
      { id: "maxTokens", label: "Max tokens", value: "4096" },
    ];
    this.form = new Form(tui, theme, "Add Custom Model", fields);
    this.form.onSubmit = (values) => this.handleSubmit(values);
    this.form.onCancel = () => onCancel();
  }

  invalidate(): void {
    this.form.invalidate();
  }

  render(width: number): string[] {
    const lines = this.form.render(width);
    if (this.error) {
      lines.push(truncateToWidth(this.theme.fg("error", `Error: ${this.error}`), width));
    }
    return lines;
  }

  handleInput(data: string): void {
    this.form.handleInput(data);
  }

  private handleSubmit(values: Record<string, string>): void {
    this.error = undefined;
    const id = values.id.trim();
    const name = values.name.trim() || id;
    const contextWindow = parseInt(values.contextWindow.trim(), 10);
    const maxTokens = parseInt(values.maxTokens.trim(), 10);
    if (!id) {
      this.error = "Model id is required";
      this.tui.requestRender();
      return;
    }
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      this.error = "Context window must be a positive number";
      this.tui.requestRender();
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      this.error = "Max tokens must be a positive number";
      this.tui.requestRender();
      return;
    }
    this.onSubmit({ id, name, contextWindow, maxTokens });
  }
}
