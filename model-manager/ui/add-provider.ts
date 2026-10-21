import type { KnownApi } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { Form, type FormField } from "./components.js";

const KNOWN_APIS: KnownApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "bedrock-converse-stream",
];

export interface NewProviderValues {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: KnownApi;
}

export class AddProviderScreen {
  private tui: TUI;
  private theme: Theme;
  private form: Form;
  private onSubmit: (values: NewProviderValues) => void;
  private onCancel: () => void;
  private error?: string;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    _ctx: ExtensionContext | ExtensionCommandContext,
    onSubmit: (values: NewProviderValues) => void,
    onCancel: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    const fields: FormField[] = [
      { id: "id", label: "Provider id", value: "my-provider" },
      { id: "name", label: "Display name", value: "My Provider" },
      { id: "baseUrl", label: "Base URL", value: "https://api.example.com/v1" },
      { id: "apiKey", label: "API key or $ENV_VAR", value: "$MY_API_KEY", password: true },
      { id: "api", label: "API type", value: "openai-completions" },
    ];
    this.form = new Form(tui, theme, "Add Custom Provider", fields);
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
    } else {
      lines.push(truncateToWidth(this.theme.fg("dim", `Known APIs: ${KNOWN_APIS.join(", ")}`), width));
    }
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    this.form.handleInput(data);
  }

  private handleSubmit(values: Record<string, string>): void {
    this.error = undefined;
    if (!values.id.trim()) {
      this.error = "Provider id is required";
      this.tui.requestRender();
      return;
    }
    if (!values.baseUrl.trim()) {
      this.error = "Base URL is required";
      this.tui.requestRender();
      return;
    }
    if (!values.apiKey.trim()) {
      this.error = "API key is required";
      this.tui.requestRender();
      return;
    }
    const api = values.api.trim();
    if (!KNOWN_APIS.includes(api as KnownApi)) {
      this.error = `Unknown API type: ${api}`;
      this.tui.requestRender();
      return;
    }
    this.onSubmit({
      id: values.id.trim(),
      name: values.name.trim() || values.id.trim(),
      baseUrl: values.baseUrl.trim(),
      apiKey: values.apiKey.trim(),
      api: api as KnownApi,
    });
  }
}
