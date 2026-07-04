import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import path from "node:path";
import { extractProject } from "./project.js";

export interface BrowseItem {
  source_path: string;
  project: string;
  date: string;
  title: string;
  subtitle: string;
  snippet: string;
  score?: number;
}

export type BrowserAction = "read" | "resume" | "export";

export interface BrowserOptions {
  ui: any;
  title: string;
  items: BrowseItem[];
  mode?: "read" | "resume";
}

const ITEM_ROWS = 4;

export async function openSessionBrowser(
  options: BrowserOptions,
): Promise<{ item: BrowseItem; action: BrowserAction } | undefined> {
  const { ui, title, items, mode = "read" } = options;
  if (items.length === 0) return undefined;
  return new Promise((resolve) => {
    ui.custom((tui: TUI, theme: any, _kb: any, done: () => void) => {
      let selectedIndex = 0;
      let scrollOffset = 0;

      const closeWith = (item?: BrowseItem, action?: BrowserAction) => {
        done();
        if (item && action) resolve({ item, action });
        else resolve(undefined);
      };

      function pageSize(): number {
        return Math.max(1, Math.floor((tui.terminal.rows - 3) / ITEM_ROWS));
      }

      function handleInput(data: string): void {
        const kb = getKeybindings();
        if (kb.matches(data, "tui.select.up")) {
          selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
        } else if (kb.matches(data, "tui.select.down")) {
          selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
        } else if (kb.matches(data, "tui.select.pageUp")) {
          selectedIndex = Math.max(0, selectedIndex - pageSize());
        } else if (kb.matches(data, "tui.select.pageDown")) {
          selectedIndex = Math.min(items.length - 1, selectedIndex + pageSize());
        } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
          closeWith();
          return;
        } else if (kb.matches(data, "tui.select.confirm")) {
          closeWith(items[selectedIndex], mode === "resume" ? "resume" : "read");
          return;
        } else if (data === "r" || data === "R") {
          closeWith(items[selectedIndex], "resume");
          return;
        } else if (data === "e" || data === "E") {
          closeWith(items[selectedIndex], "export");
          return;
        } else {
          return;
        }
        tui.requestRender();
      }

      function render(width: number): string[] {
        const rows = tui.terminal.rows || 24;
        const headerRows = 2;
        const footerRows = 1;
        const listHeight = Math.max(ITEM_ROWS, rows - headerRows - footerRows);
        const maxVisible = Math.max(1, Math.floor(listHeight / ITEM_ROWS));

        if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
        else if (selectedIndex >= scrollOffset + maxVisible) scrollOffset = selectedIndex - maxVisible + 1;
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, items.length - maxVisible)));

        const leftWidth = Math.max(36, Math.floor(width * 0.38));
        const rightWidth = Math.max(20, width - leftWidth - 1);

        const lines: string[] = [];
        lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));
        lines.push(
          truncateToWidth(
            theme.fg(
              "dim",
              mode === "resume"
                ? "↑↓ move · Enter resume · R read · E export · Esc cancel"
                : "↑↓ move · Enter read · R resume · E export · Esc cancel",
            ),
            width,
          ),
        );

        const selected = items[selectedIndex];
        const previewLines = buildPreviewLines(selected, rightWidth, listHeight, theme);

        for (let row = 0; row < listHeight; row++) {
          const itemIndex = scrollOffset + Math.floor(row / ITEM_ROWS);
          const itemRow = row % ITEM_ROWS;
          let left = "";

          if (itemIndex < items.length) {
            const item = items[itemIndex];
            const isSelected = itemIndex === selectedIndex;
            const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
            const contentWidth = leftWidth - 2;
            if (itemRow === 0) {
              const raw = isSelected ? theme.fg("accent", theme.bold(item.title)) : theme.fg("text", item.title);
              left = padOrTruncate(prefix + truncateToWidth(raw, contentWidth), leftWidth);
            } else if (itemRow === 1) {
              left = padOrTruncate(prefix + truncateToWidth(theme.fg("dim", item.subtitle), contentWidth), leftWidth);
            } else if (itemRow === 2) {
              const firstSnippetLine = item.snippet.split(/\r?\n/)[0] ?? "";
              left = padOrTruncate(
                prefix + truncateToWidth(theme.fg("dim", firstSnippetLine), contentWidth),
                leftWidth,
              );
            } else {
              left = " ".repeat(leftWidth);
            }
          } else {
            left = " ".repeat(leftWidth);
          }

          const right = padOrTruncate(previewLines[row] ?? " ", rightWidth);
          const divider = theme.fg("dim", "│");
          lines.push(truncateToWidth(left + divider + right, width));
        }

        const footer = `${selectedIndex + 1}/${items.length} · ${selected.project}`;
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      }

      return { render, handleInput, invalidate() {} };
    });
  });
}

function buildPreviewLines(item: BrowseItem, width: number, height: number, theme: any): string[] {
  const lines: string[] = [];

  const push = (text: string, style?: (s: string) => string) => {
    if (!text) return;
    const styled = style ? style(text) : text;
    for (const line of wrapTextWithAnsi(styled, width)) {
      lines.push(line);
    }
  };
  const empty = () => lines.push("");

  push(item.title, (s) => theme.fg("accent", theme.bold(s)));
  let meta = `${formatDate(item.date)} · ${item.project}`;
  if (item.score !== undefined) meta += ` · relevance ${item.score.toFixed(3)}`;
  push(meta, (s) => theme.fg("dim", s));
  empty();
  push(item.snippet);
  empty();
  push(path.basename(item.source_path), (s) => theme.fg("dim", s));

  return lines.map((l) => padOrTruncate(l, width)).slice(0, height);
}

function padOrTruncate(line: string, width: number): string {
  const vis = visibleWidth(line);
  if (vis > width) return truncateToWidth(line, width);
  if (vis < width) return line + " ".repeat(width - vis);
  return line;
}

function formatDate(date: string): string {
  if (!date) return "unknown";
  return date.replace("T", " ").slice(0, 19);
}

export function browseItemFromListItem(s: { source_path: string; project: string; date: string; preview?: string }): BrowseItem {
  const project = s.project || extractProject(s.source_path);
  const date = formatDate(s.date);
  const preview = (s.preview || "").replace(/\s+/g, " ").trim();
  let title = "";
  let snippet = "";

  const arrowIdx = preview.indexOf(" -> assistant:");
  if (arrowIdx >= 0 && preview.startsWith("user: ")) {
    title = preview.slice(6, arrowIdx).trim();
    snippet = preview.slice(arrowIdx + 14).trim();
  } else {
    title = preview.slice(0, 100);
    snippet = "";
  }

  if (!title) {
    title = path.basename(s.source_path, ".jsonl");
  }
  if (title.length > 120) title = title.slice(0, 119) + "…";
  if (snippet.length > 300) snippet = snippet.slice(0, 299) + "…";

  return {
    source_path: s.source_path,
    project,
    date,
    title,
    subtitle: `${date} · ${project}`,
    snippet,
  };
}

export function browseItemFromHit(h: { source_path: string; text: string; score: number; date?: string }): BrowseItem {
  const project = extractProject(h.source_path);
  const date = formatDate(h.date || "");
  const text = (h.text || "").trim();

  const userMatch = text.match(/\[User\]\s*(.+?)(?=\n\[Assistant\]|\n\[ToolResult\]|\n\[User\]|$)/s);
  const assistantMatch = text.match(/\[Assistant\]\s*(.+?)(?=\n\[User\]|\n\[ToolResult\]|\n\[Assistant\]|$)/s);

  let title = userMatch ? userMatch[1].trim().replace(/\s+/g, " ") : "";
  let snippet = assistantMatch ? assistantMatch[1].trim().replace(/\s+/g, " ") : "";

  if (!title) title = path.basename(h.source_path, ".jsonl");
  if (!snippet) snippet = text.replace(/\s+/g, " ").trim();
  if (title.length > 120) title = title.slice(0, 119) + "…";
  if (snippet.length > 400) snippet = snippet.slice(0, 399) + "…";

  return {
    source_path: h.source_path,
    project,
    date,
    title,
    subtitle: `${date} · ${project}`,
    snippet,
    score: h.score,
  };
}
