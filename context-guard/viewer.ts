/**
 * Generic read-only scrollable text viewer (overlay).
 * Replaces the abuse of ctx.ui.editor() as a viewer — editor() is an editable
 * dialog whose result was discarded, which made reports look editable but
 * weren't. This viewer is honestly read-only: scroll keys, q/Esc to close.
 *
 * Pattern mirrors pi-session-memory/session-viewer.ts (battle-tested):
 * overlay + done() so the promise always settles and the editor is restored.
 */
import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface TextViewerOptions {
  title: string;
  text: string;
  /** Optional dim second header line (e.g. source / capture time). */
  subtitle?: string;
}

/** Minimal structural type of ctx.ui.custom — avoids importing full ctx types. */
export interface ViewerUI {
  custom<T>(
    factory: (tui: TUI, theme: any, keybindings: unknown, done: (result: T) => void) => unknown,
    options?: { overlay?: boolean },
  ): Promise<T>;
}

function padOrTruncate(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w > width) return truncateToWidth(line, width);
  if (w < width) return line + " ".repeat(width - w);
  return line;
}

export async function openTextViewer(ui: ViewerUI, options: TextViewerOptions): Promise<void> {
  const { title, text, subtitle } = options;
  return ui.custom<void>(
    (tui: TUI, theme: any, _kb: unknown, done: (result: void) => void) => {
      let scrollTop = 0;
      let cachedWidth = 0;
      let cachedLines: string[] = [];
      let closed = false;

      const header: string[] = [theme.fg("accent", theme.bold(title))];
      if (subtitle) header.push(theme.fg("dim", subtitle));

      function getLines(width: number): string[] {
        if (cachedWidth === width && cachedLines.length > 0) return cachedLines;
        const contentWidth = Math.max(20, width - 2);
        const lines: string[] = [];
        for (const raw of text.split(/\r?\n/)) {
          const line = raw || " ";
          const wrapped = wrapTextWithAnsi(line, contentWidth);
          for (const w of wrapped) lines.push(" " + padOrTruncate(w, contentWidth));
        }
        cachedWidth = width;
        cachedLines = lines;
        return lines;
      }

      function close(): void {
        if (closed) return;
        closed = true;
        done();
      }

      function handleInput(data: string): void {
        if (closed) return;
        const kb = getKeybindings();
        const rows = tui.terminal.rows || 24;
        const visible = Math.max(1, rows - header.length - 2);
        const total = getLines(tui.terminal.columns || 80).length;
        const maxTop = Math.max(0, total - visible);

        if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
          close();
          return;
        } else if (kb.matches(data, "tui.select.up") || data === "k") {
          scrollTop = Math.max(0, scrollTop - 1);
        } else if (kb.matches(data, "tui.select.down") || data === "j") {
          scrollTop = Math.min(maxTop, scrollTop + 1);
        } else if (kb.matches(data, "tui.select.pageUp")) {
          scrollTop = Math.max(0, scrollTop - visible);
        } else if (kb.matches(data, "tui.select.pageDown")) {
          scrollTop = Math.min(maxTop, scrollTop + visible);
        } else if (data === "g") {
          scrollTop = 0;
        } else if (data === "G") {
          scrollTop = maxTop;
        } else {
          return;
        }
        tui.requestRender();
      }

      function render(width: number): string[] {
        const rows = tui.terminal.rows || 24;
        const lines = getLines(width);
        const visible = Math.max(1, rows - header.length - 2);
        scrollTop = Math.min(scrollTop, Math.max(0, lines.length - visible));

        const out: string[] = [...header];
        const start = scrollTop;
        const end = Math.min(lines.length, start + visible);
        for (let i = start; i < end; i++) out.push(lines[i]);
        while (out.length < rows - 1) out.push(" ");

        const progress = lines.length > 0 ? `${Math.min(lines.length, end)}/${lines.length}` : "0/0";
        const footer = `↑↓ PgUp/PgDn scroll · g top · G bottom · q/Esc close · ${progress}`;
        out.push(truncateToWidth(theme.fg("dim", footer), width));
        return out;
      }

      return { render, handleInput, invalidate() {} };
    },
    { overlay: true },
  );
}
