import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import path from "node:path";
import { extractProject } from "./project.js";

export type ViewerAction = "back" | "resume" | "export";

export interface ViewerOptions {
  ui: any;
  sourcePath: string;
  project: string;
  date: string;
  text: string;
}

export async function openSessionViewer(options: ViewerOptions): Promise<ViewerAction> {
  const { ui, sourcePath, project, date, text } = options;
  return new Promise((resolve) => {
    ui.custom((tui: TUI, theme: any, _kb: any, done: () => void) => {
      let scrollTop = 0;
      let cachedWidth = 0;
      let cachedLines: string[] = [];

      const header = buildHeader(sourcePath, project, date, text, theme);

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

      function close(action: ViewerAction) {
        done();
        resolve(action);
      }

      function handleInput(data: string): void {
        const kb = getKeybindings();
        const rows = tui.terminal.rows || 24;
        const visible = Math.max(1, rows - header.length - 2);
        const total = getLines(tui.terminal.columns || 80).length;

        if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
          close("back");
          return;
        } else if (data === "r" || data === "R") {
          close("resume");
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
        } else if (data === "g" || data === "G") {
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
        const footer = `↑↓ PgUp/PgDn scroll · G top · Shift+G bottom · R resume · E export · Q back · ${progress}`;
        out.push(truncateToWidth(theme.fg("dim", footer), width));
        return out;
      }

      return { render, handleInput, invalidate() {} };
    });
  });
}

function buildHeader(sourcePath: string, project: string, date: string, text: string, theme: any): string[] {
  const fileName = path.basename(sourcePath);
  const dateStr = date ? date.replace("T", " ").slice(0, 19) : "unknown";
  const lines = [
    theme.fg("accent", theme.bold(`Session: ${fileName}`)),
    theme.fg("dim", `${dateStr} · ${project || extractProject(sourcePath)}`),
  ];
  return lines;
}

function padOrTruncate(line: string, width: number): string {
  const vis = visibleWidth(line);
  if (vis > width) return truncateToWidth(line, width);
  if (vis < width) return line + " ".repeat(width - vis);
  return line;
}
