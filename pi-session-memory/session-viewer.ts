import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import path from "node:path";
import { extractProject } from "./project.js";
import {
  formatMtimeLabel,
  formatSizeLabel,
  type LocalSessionMeta,
  type PreviewMessage,
} from "./local-sessions.js";

export type ViewerAction = "back" | "open" | "export";

export interface ViewerOptions {
  ui: any;
  sourcePath: string;
  project: string;
  date: string;
  meta: LocalSessionMeta;
  messages: PreviewMessage[];
  /** Shown instead of messages when the file could not be read. */
  note?: string;
}

/**
 * Chat-style head preview: user/assistant dialog as styled blocks.
 * Overlay + done(result) so cancel/open/export always settle.
 */
export async function openSessionViewer(options: ViewerOptions): Promise<ViewerAction> {
  const { ui, sourcePath, project, date, meta, messages, note } = options;
  return ui.custom(
    (tui: TUI, theme: any, _kb: any, done: (action: ViewerAction) => void) => {
      let scrollTop = 0;
      let cachedWidth = 0;
      let cachedLines: string[] = [];
      let closed = false;

      const header = buildHeader(sourcePath, project, date, meta, theme);

      function getLines(width: number): string[] {
        if (cachedWidth === width && cachedLines.length > 0) return cachedLines;
        const contentWidth = Math.max(20, width - 2);
        const lines: string[] = [];
        const wrapBlock = (text: string, style: (s: string) => string) => {
          for (const raw of text.split(/\r?\n/)) {
            const line = raw || " ";
            for (const w of wrapTextWithAnsi(line, contentWidth - 2)) {
              lines.push("  " + padOrTruncate(style(w), contentWidth));
            }
          }
        };

        if (note) {
          lines.push(" ");
          wrapBlock(note, (s) => theme.fg("warning", s));
        } else if (messages.length === 0) {
          lines.push(" ");
          lines.push("  " + theme.fg("dim", "(no user/assistant messages in head scan)"));
        } else {
          for (const m of messages) {
            lines.push(" ");
            const label =
              m.role === "user"
                ? theme.fg("accent", theme.bold("▸ User"))
                : theme.fg("text", theme.bold("▸ Assistant"));
            lines.push("  " + label);
            wrapBlock(m.text, (s) => (m.role === "user" ? theme.fg("text", s) : theme.fg("dim", s)));
          }
        }
        lines.push(" ");
        lines.push(theme.fg("dim", "─".repeat(Math.min(40, contentWidth))));
        lines.push(theme.fg("dim", "Head-only preview — open the session for the full history"));

        cachedWidth = width;
        cachedLines = lines;
        return lines;
      }

      function close(action: ViewerAction) {
        if (closed) return;
        closed = true;
        done(action);
      }

      function handleInput(data: string): void {
        if (closed) return;
        const kb = getKeybindings();
        const rows = tui.terminal.rows || 24;
        const visible = Math.max(1, rows - header.length - 2);
        const total = getLines(tui.terminal.columns || 80).length;

        if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
          close("back");
          return;
        } else if (kb.matches(data, "tui.select.confirm") || data === "o" || data === "O") {
          close("open");
          return;
        } else if (data === "e" || data === "E") {
          close("export");
          return;
        } else if (kb.matches(data, "tui.select.up")) {
          scrollTop = Math.max(0, scrollTop - 1);
        } else if (kb.matches(data, "tui.select.down")) {
          scrollTop = Math.min(Math.max(0, total - visible), scrollTop + 1);
        } else if (kb.matches(data, "tui.select.pageUp")) {
          scrollTop = Math.max(0, scrollTop - visible);
        } else if (kb.matches(data, "tui.select.pageDown")) {
          scrollTop = Math.min(Math.max(0, total - visible), scrollTop + visible);
        } else if (data === "g") {
          scrollTop = 0;
        } else if (data === "G") {
          scrollTop = Math.max(0, total - visible);
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
        for (let i = start; i < end; i++) {
          out.push(lines[i]);
        }
        while (out.length < rows - 1) out.push(" ");

        const progress = lines.length > 0 ? `${Math.min(lines.length, start + visible)}/${lines.length}` : "0/0";
        const canScroll = lines.length > visible;
        const scrollKeys = canScroll ? "↑↓ PgUp/PgDn · g/G · " : "";
        const footer = `${scrollKeys}Enter/O open · E export · Q back · ${progress}`;
        out.push(truncateToWidth(theme.fg("dim", footer), width));
        return out;
      }

      return { render, handleInput, invalidate() {} };
    },
    // Near-full-screen, consistent with the session browser.
    { overlay: true, overlayOptions: { width: "95%" } },
  );
}

function buildHeader(sourcePath: string, project: string, date: string, meta: LocalSessionMeta, theme: any): string[] {
  const fileName = path.basename(sourcePath);
  const dateStr = date ? date.replace("T", " ").slice(0, 19) : "unknown";
  const lines = [
    theme.fg("accent", theme.bold(`Preview: ${meta.title && meta.title !== fileName ? meta.title : fileName}`)),
    theme.fg("dim", `${dateStr} · ${project || extractProject(sourcePath)}`),
    theme.fg(
      "dim",
      `modified ${formatMtimeLabel(meta.mtime)} · ${formatSizeLabel(meta.sizeBytes)} · ` +
        `~${meta.userMessages} user / ~${meta.assistantMessages} assistant in head${meta.scanTruncated ? " (truncated)" : ""}`,
    ),
  ];
  if (meta.tools.length) {
    lines.push(theme.fg("dim", `Tools: ${meta.tools.join(", ")}`));
  }
  return lines;
}

function padOrTruncate(line: string, width: number): string {
  const vis = visibleWidth(line);
  if (vis > width) return truncateToWidth(line, width);
  if (vis < width) return line + " ".repeat(width - vis);
  return line;
}
