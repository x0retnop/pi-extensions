import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";

export interface CheckboxItem {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
}

export class CheckboxList implements Component {
  items: CheckboxItem[];
  filteredItems: CheckboxItem[];
  selectedIndex = 0;
  private tui: TUI;
  private theme: Theme;
  private maxVisible: number;
  private searchInput?: Input;
  private searchEnabled: boolean;
  /** When true, printable keys go to the filter (activated by `/`). */
  private searchMode = false;
  onChange?: (item: CheckboxItem) => void;
  onConfirm?: () => void;
  onCancel?: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    items: CheckboxItem[],
    maxVisible: number,
    options: { search?: boolean } = {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.searchEnabled = options.search ?? false;
    if (this.searchEnabled) {
      this.searchInput = new Input();
    }
  }

  invalidate(): void {
    this.searchInput?.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    if (this.searchEnabled && this.searchInput) {
      if (this.searchMode) {
        lines.push(this.theme.fg("muted", "Filter: ") + this.searchInput.render(width - 8).join(""));
      } else {
        const q = this.searchInput.getValue();
        lines.push(
          q
            ? this.theme.fg("muted", "Filter: ") + this.theme.fg("text", q) + this.theme.fg("dim", "  (/ edit · Esc clear)")
            : this.theme.fg("dim", "Filter: (press / to search)"),
        );
      }
      lines.push("");
    }
    const display = this.displayItems();
    if (display.length === 0) {
      lines.push(this.theme.fg("dim", "  No items"));
      return lines;
    }
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), display.length - this.maxVisible),
    );
    const end = Math.min(start + this.maxVisible, display.length);
    for (let i = start; i < end; i++) {
      const item = display[i];
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      const box = item.checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const label = selected ? this.theme.fg("accent", item.label) : this.theme.fg("text", item.label);
      lines.push(truncateToWidth(`${prefix}${box} ${label}`, width));
    }
    if (start > 0 || end < display.length) {
      lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${display.length})`));
    }
    const selectedItem = display[this.selectedIndex];
    if (selectedItem?.description) {
      lines.push("");
      for (const line of wrapLines(selectedItem.description, width - 4)) {
        lines.push(truncateToWidth(this.theme.fg("muted", `  ${line}`), width));
      }
    }
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const display = this.displayItems();

    // Search mode: typing filters the list. Arrows still navigate; Enter leaves
    // search mode (keeps filter); Esc clears filter and leaves search mode.
    if (this.searchEnabled && this.searchInput && this.searchMode) {
      if (kb.matches(data, "tui.select.cancel")) {
        this.searchMode = false;
        this.searchInput.setValue("");
        this.applyFilter("");
      } else if (kb.matches(data, "tui.select.confirm")) {
        this.searchMode = false;
      } else if (kb.matches(data, "tui.select.up")) {
        this.selectedIndex = display.length === 0 ? 0 : this.selectedIndex === 0 ? display.length - 1 : this.selectedIndex - 1;
      } else if (kb.matches(data, "tui.select.down")) {
        this.selectedIndex = display.length === 0 ? 0 : this.selectedIndex === display.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (data === " ") {
        this.toggleSelected();
      } else {
        this.searchInput.handleInput(data);
        this.applyFilter(this.searchInput.getValue());
      }
      this.tui.requestRender();
      return;
    }

    if (this.searchEnabled && data === "/") {
      this.searchMode = true;
      this.tui.requestRender();
      return;
    }

    // List actions — never swallowed by the filter.
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = display.length === 0 ? 0 : this.selectedIndex === 0 ? display.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = display.length === 0 ? 0 : this.selectedIndex === display.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (data === " ") {
      this.toggleSelected();
    } else if (data === "a" || data === "A") {
      this.toggleAll();
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.onConfirm?.();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      // Esc while a filter is active clears it first (same as other /mm screens).
      if (this.searchEnabled && this.searchInput?.getValue()) {
        this.searchInput.setValue("");
        this.applyFilter("");
      } else {
        this.onCancel?.();
      }
    }
    this.tui.requestRender();
  }

  private displayItems(): CheckboxItem[] {
    return this.searchEnabled ? this.filteredItems : this.items;
  }

  private applyFilter(query: string): void {
    const q = query.toLowerCase();
    this.filteredItems = q
      ? this.items.filter((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
      : this.items;
    this.selectedIndex = 0;
  }

  private toggleSelected(): void {
    const display = this.displayItems();
    const item = display[this.selectedIndex];
    if (!item) return;
    item.checked = !item.checked;
    this.onChange?.(item);
  }

  private toggleAll(): void {
    // Toggle against the *filtered* set when a filter is active, so "a" selects
    // only visible matches — useful when curating large catalogs.
    const target = this.displayItems();
    if (target.length === 0) return;
    const next = target.some((i) => !i.checked);
    for (const item of target) {
      item.checked = next;
    }
    this.onChange?.(target[this.selectedIndex] ?? target[0]);
  }
}

export interface FormField {
  id: string;
  label: string;
  value: string;
  password?: boolean;
}

export class Form implements Component {
  fields: FormField[];
  selectedIndex = 0;
  private tui: TUI;
  private theme: Theme;
  private title: string;
  private input: Input;
  onSubmit?: (values: Record<string, string>) => void;
  onCancel?: () => void;

  constructor(tui: TUI, theme: Theme, title: string, fields: FormField[]) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.fields = fields;
    this.input = new Input();
    this.input.setValue(fields[0]?.value ?? "");
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
    lines.push("");
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i];
      const active = i === this.selectedIndex;
      const marker = active ? this.theme.fg("accent", "> ") : "  ";
      const label = active ? this.theme.fg("accent", field.label) : this.theme.fg("text", field.label);
      const value = field.password && field.value ? "*".repeat(field.value.length) : field.value;
      const rendered = active
        ? this.input.render(width - 4).join("")
        : value || this.theme.fg("dim", "(empty)");
      lines.push(truncateToWidth(`${marker}${label}: ${rendered}`, width));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "↑↓ move · Enter next/confirm · Esc cancel"));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.saveField();
      this.selectedIndex = this.selectedIndex === 0 ? this.fields.length - 1 : this.selectedIndex - 1;
      this.loadField();
    } else if (kb.matches(data, "tui.select.down")) {
      this.saveField();
      this.selectedIndex = this.selectedIndex === this.fields.length - 1 ? 0 : this.selectedIndex + 1;
      this.loadField();
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.saveField();
      if (this.selectedIndex < this.fields.length - 1) {
        this.selectedIndex++;
        this.loadField();
      } else {
        const values: Record<string, string> = {};
        for (const f of this.fields) values[f.id] = f.value;
        this.onSubmit?.(values);
      }
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
    } else {
      this.input.handleInput(data);
      this.saveField();
    }
    this.tui.requestRender();
  }

  private loadField(): void {
    const field = this.fields[this.selectedIndex];
    this.input.setValue(field?.value ?? "");
  }

  private saveField(): void {
    const field = this.fields[this.selectedIndex];
    if (field) {
      field.value = this.input.getValue();
    }
  }
}

export function wrapLines(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
