import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import path from "node:path";
import { extractProject } from "./project.js";
import {
  formatMtimeLabel,
  formatSizeLabel,
  nextSessionScope,
  sessionScopeLabel,
  type BrowserScope,
  type LocalSessionMeta,
  type SessionProject,
} from "./local-sessions.js";

export interface BrowseItem {
  source_path: string;
  project: string;
  date: string;
  /** One-line human title. */
  title: string;
  /** Compact meta for the second list line (time · size · …). */
  subtitle: string;
  /** Longer text for full preview (P), not shown in list. */
  snippet: string;
  score?: number;
  name?: string;
  sizeLabel?: string;
  mtimeLabel?: string;
  /** Absolute last-modified ms (local sessions). */
  mtime?: number;
  /** Raw first user message (2-line list display). */
  firstUser?: string;
  /** Model-written annotation: replaces the first-message line when present. */
  annotation?: { title: string; summary: string; at: string };
  toolsLabel?: string;
  /** Short project leaf for all-scope lists. */
  projectLeaf?: string;
  /** Project picker row (By project scope). Default = session. */
  kind?: "session" | "project";
  /** Encoded sessions subdir; used to list that cwd without re-encoding. */
  dirName?: string;
  sessionCount?: number;
}

export type BrowserAction = "open" | "preview" | "export" | "delete" | "select";

export interface BrowserOptions {
  ui: any;
  title: string;
  items: BrowseItem[];
  /** Default Enter action: open = switch session, select = return item (export picker). */
  mode?: "open" | "preview" | "delete" | "select";
  /** Shown in header; Tab cycles when onScopeChange is set. */
  scope?: BrowserScope;
  /** Reload list for a new scope (mutates live). */
  onScopeChange?: (scope: BrowserScope) => BrowseItem[] | Promise<BrowseItem[]>;
  /** Enter on a project row → that cwd's sessions. */
  onProjectOpen?: (item: BrowseItem) => BrowseItem[] | Promise<BrowseItem[]>;
  /** Esc from a drilled-in project list → back to the project picker. */
  onDrillBack?: () => BrowseItem[] | Promise<BrowseItem[]>;
  /** Already inside a project (outer loop restored after preview/export). */
  drilledProject?: BrowseItem;
  /** Skip Current cwd in Tab cycle when it equals Project tree (no child session dirs). */
  skipCurrentScope?: boolean;
  onDelete?: (item: BrowseItem) => Promise<{ ok: boolean; error?: string }>;
}

/** Three lines per session: first message ×2 + meta — readable at a glance. */
const ITEM_ROWS = 3;

/**
 * Session list browser (local-first Open flow).
 * Single-column compact list; detail preview is on P, not a live split pane.
 */
export async function openSessionBrowser(
  options: BrowserOptions,
): Promise<{ item: BrowseItem; action: BrowserAction } | undefined> {
  const { ui, title } = options;
  const items = options.items;
  const mode = options.mode ?? "open";
  let scope = options.scope;

  if (items.length === 0 && !options.onScopeChange) return undefined;

  return ui.custom(
    (tui: TUI, theme: any, _kb: any, done: (result?: { item: BrowseItem; action: BrowserAction }) => void) => {
      let selectedIndex = 0;
      let scrollOffset = 0;
      let isBusy = false;
      let closed = false;
      let statusMsg: string | null = null;
      /** Incremental filter ("/" enters filter mode; text matches title/first message/project). */
      let filter = "";
      let filtering = false;
      /** N toggles "annotated only" — same idea as the built-in resume list's Named filter. */
      let onlyAnnotated = false;
      /** Set when the user opened a cwd from the By project picker. */
      let drilled: BrowseItem | undefined = options.drilledProject;
      let projectSnapshot: BrowseItem[] | null = null;
      /** Inline delete confirm — never nest ui.confirm (it mounts behind this overlay). */
      let pendingDelete: BrowseItem | undefined;

      const component = {
        render,
        handleInput,
        invalidate() {},
      };

      function visibleItems(): BrowseItem[] {
        const base = onlyAnnotated ? items.filter((it) => it.kind === "project" || !!it.annotation) : items;
        if (!filter) return base;
        const q = filter.toLowerCase();
        return base.filter((it) =>
          (it.title || "").toLowerCase().includes(q) ||
          (it.firstUser || "").toLowerCase().includes(q) ||
          (it.project || "").toLowerCase().includes(q) ||
          (it.name || "").toLowerCase().includes(q) ||
          (it.annotation?.summary || "").toLowerCase().includes(q),
        );
      }

      function closeWith(item?: BrowseItem, action?: BrowserAction): void {
        if (closed) return;
        closed = true;
        if (item && action) done({ item, action });
        else done(undefined);
      }

      function pageSize(): number {
        return Math.max(1, Math.floor((tui.terminal.rows - 4) / ITEM_ROWS));
      }

      function refocus(): void {
        try {
          (tui as any).setFocus?.(component);
        } catch {
          // ignore
        }
        tui.requestRender();
      }

      function requestDelete(item: BrowseItem) {
        if (item.kind === "project" || isBusy || closed) return;
        pendingDelete = item;
        tui.requestRender();
      }

      async function deleteItem(item: BrowseItem) {
        if (item.kind === "project") return;
        if (isBusy || closed) return;
        pendingDelete = undefined;
        if (options.onDelete) {
          isBusy = true;
          tui.requestRender();
          try {
            const result = await options.onDelete(item);
            if (closed) return;
            if (result?.ok) {
              const at = items.indexOf(item);
              if (at >= 0) items.splice(at, 1);
              const visible = visibleItems();
              if (visible.length === 0) {
                statusMsg = filter ? `No matches · "${filter}"` : "No sessions left";
                selectedIndex = 0;
              } else if (selectedIndex >= visible.length) {
                selectedIndex = visible.length - 1;
              }
            } else if (result && !result.ok) {
              statusMsg = result.error || "Delete failed";
            }
          } finally {
            isBusy = false;
          }
          refocus();
        } else {
          closeWith(item, "delete");
        }
      }

      async function cycleScope() {
        if (!options.onScopeChange || !scope || isBusy || closed) return;
        const next = nextSessionScope(scope, { skipCurrent: options.skipCurrentScope });
        isBusy = true;
        statusMsg = `Loading ${sessionScopeLabel(next)}…`;
        tui.requestRender();
        try {
          const nextItems = await options.onScopeChange(next);
          if (closed) return;
          scope = next;
          drilled = undefined;
          projectSnapshot = null;
          items.splice(0, items.length, ...(nextItems || []));
          selectedIndex = 0;
          scrollOffset = 0;
          filter = "";
          filtering = false;
          const emptyKind = scope === "projects" ? "No projects" : "No sessions";
          statusMsg = items.length === 0 ? `${emptyKind} · ${sessionScopeLabel(scope)}` : null;
        } catch (err) {
          statusMsg = err instanceof Error ? err.message : String(err);
        } finally {
          isBusy = false;
          refocus();
        }
      }

      async function openProject(item: BrowseItem) {
        if (!options.onProjectOpen || item.kind !== "project" || isBusy || closed) return;
        isBusy = true;
        statusMsg = `Loading ${item.project || item.title}…`;
        tui.requestRender();
        try {
          const nextItems = await options.onProjectOpen(item);
          if (closed) return;
          if (!projectSnapshot) projectSnapshot = items.slice();
          items.splice(0, items.length, ...(nextItems || []));
          drilled = item;
          selectedIndex = 0;
          scrollOffset = 0;
          filter = "";
          filtering = false;
          statusMsg = items.length === 0 ? `No sessions · ${item.project || item.title}` : null;
        } catch (err) {
          statusMsg = err instanceof Error ? err.message : String(err);
        } finally {
          isBusy = false;
          refocus();
        }
      }

      async function backFromProject(): Promise<boolean> {
        if (!drilled || isBusy || closed) return false;
        if (options.onDrillBack) {
          isBusy = true;
          tui.requestRender();
          try {
            const nextItems = await options.onDrillBack();
            if (closed) return true;
            items.splice(0, items.length, ...(nextItems || []));
            drilled = undefined;
            projectSnapshot = null;
            selectedIndex = 0;
            scrollOffset = 0;
            filter = "";
            filtering = false;
            statusMsg = items.length === 0 ? "No projects" : null;
          } catch (err) {
            statusMsg = err instanceof Error ? err.message : String(err);
          } finally {
            isBusy = false;
            refocus();
          }
          return true;
        }
        if (projectSnapshot) {
          items.splice(0, items.length, ...projectSnapshot);
          drilled = undefined;
          selectedIndex = 0;
          scrollOffset = 0;
          filter = "";
          filtering = false;
          statusMsg = null;
          tui.requestRender();
          return true;
        }
        return false;
      }

      function handleInput(data: string): void {
        if (closed || isBusy) return;
        const kb = getKeybindings();

        if (pendingDelete) {
          if (
            kb.matches(data, "tui.select.confirm") ||
            data === "y" ||
            data === "Y" ||
            data === "d" ||
            data === "D"
          ) {
            const item = pendingDelete;
            pendingDelete = undefined;
            void deleteItem(item);
          } else if (
            kb.matches(data, "tui.select.cancel") ||
            data === "n" ||
            data === "N" ||
            data === "q" ||
            data === "Q"
          ) {
            pendingDelete = undefined;
            tui.requestRender();
          }
          return;
        }

        const visible = visibleItems();

        // Filter edit mode: printable chars extend the filter; Enter keeps it,
        // Esc clears it. Up/Down still navigate so you can refine and move.
        if (filtering) {
          if (kb.matches(data, "tui.select.confirm")) {
            filtering = false;
          } else if (kb.matches(data, "tui.select.cancel")) {
            filter = "";
            filtering = false;
            selectedIndex = 0;
            scrollOffset = 0;
          } else if (kb.matches(data, "tui.select.up")) {
            if (visible.length) selectedIndex = selectedIndex === 0 ? visible.length - 1 : selectedIndex - 1;
          } else if (kb.matches(data, "tui.select.down")) {
            if (visible.length) selectedIndex = selectedIndex === visible.length - 1 ? 0 : selectedIndex + 1;
          } else if (data === "\x7f" || data === "\b") {
            filter = filter.slice(0, -1);
            selectedIndex = 0;
            scrollOffset = 0;
          } else if (data.length === 1 && data >= " ") {
            filter += data;
            selectedIndex = 0;
            scrollOffset = 0;
          } else {
            return;
          }
          tui.requestRender();
          return;
        }

        if (data === "\t" && options.onScopeChange) {
          void cycleScope();
          return;
        }

        if (kb.matches(data, "tui.select.up")) {
          if (visible.length === 0) return;
          selectedIndex = selectedIndex === 0 ? visible.length - 1 : selectedIndex - 1;
        } else if (kb.matches(data, "tui.select.down")) {
          if (visible.length === 0) return;
          selectedIndex = selectedIndex === visible.length - 1 ? 0 : selectedIndex + 1;
        } else if (kb.matches(data, "tui.select.pageUp")) {
          if (visible.length === 0) return;
          selectedIndex = Math.max(0, selectedIndex - pageSize());
        } else if (kb.matches(data, "tui.select.pageDown")) {
          if (visible.length === 0) return;
          selectedIndex = Math.min(visible.length - 1, selectedIndex + pageSize());
        } else if (data === "/") {
          filtering = true;
        } else if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
          if (filter) {
            // First cancel clears an active filter, second backs out / closes.
            filter = "";
            selectedIndex = 0;
            scrollOffset = 0;
          } else if (data !== "q" && data !== "Q" && drilled) {
            // Esc from a drilled-in cwd → project picker. Q still closes.
            void backFromProject();
            return;
          } else {
            closeWith();
            return;
          }
        } else if (kb.matches(data, "tui.select.confirm")) {
          if (visible.length === 0) return;
          const item = visible[selectedIndex];
          if (item.kind === "project") {
            void openProject(item);
            return;
          }
          if (mode === "delete") {
            requestDelete(item);
          } else {
            closeWith(item, mode === "preview" ? "preview" : mode === "select" ? "select" : "open");
          }
          return;
        } else if (data === "o" || data === "O") {
          if (visible.length === 0) return;
          const item = visible[selectedIndex];
          if (item.kind === "project") {
            void openProject(item);
            return;
          }
          closeWith(item, "open");
          return;
        } else if (data === "p" || data === "P" || data === " ") {
          if (visible.length === 0) return;
          if (visible[selectedIndex].kind === "project") return;
          closeWith(visible[selectedIndex], "preview");
          return;
        } else if (data === "e" || data === "E") {
          if (visible.length === 0) return;
          if (visible[selectedIndex].kind === "project") return;
          closeWith(visible[selectedIndex], mode === "select" ? "select" : "export");
          return;
        } else if (data === "d" || data === "D") {
          if (visible.length === 0) return;
          if (visible[selectedIndex].kind === "project") return;
          requestDelete(visible[selectedIndex]);
          return;
        } else if (data === "n" || data === "N") {
          onlyAnnotated = !onlyAnnotated;
          selectedIndex = 0;
          scrollOffset = 0;
          tui.requestRender();
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
        const visible = visibleItems();

        if (visible.length > 0) {
          if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
          else if (selectedIndex >= scrollOffset + maxVisible) scrollOffset = selectedIndex - maxVisible + 1;
          scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, visible.length - maxVisible)));
        } else {
          scrollOffset = 0;
          selectedIndex = 0;
        }

        const pickingProject = scope === "projects" && !drilled;
        const showProject = scope === "all";
        const lines: string[] = [];

        // Header: title + scope on the right
        const scopeText = drilled
          ? `By project › ${drilled.projectLeaf || drilled.title}`
          : scope
            ? sessionScopeLabel(scope)
            : "";
        const leftTitle = theme.fg("accent", theme.bold(title));
        const rightScope = scopeText
          ? theme.fg("dim", "scope ") + theme.fg("accent", scopeText) + (options.onScopeChange ? theme.fg("dim", "  Tab") : "")
          : "";
        lines.push(renderSplitLine(leftTitle, rightScope, width, theme));

        // Line 2: filter editor while filtering, otherwise action hints.
        if (pendingDelete) {
          const label = pendingDelete.title || pendingDelete.name || path.basename(pendingDelete.source_path);
          lines.push(
            truncateToWidth(
              theme.fg("accent", theme.bold("Delete? ")) +
                theme.fg("text", clip(label, Math.max(8, width - 36))) +
                theme.fg("dim", "  Y/Enter yes · N/Esc no"),
              width,
            ),
          );
        } else if (filtering) {
          lines.push(truncateToWidth(theme.fg("accent", `Filter: ${filter}█`), width));
        } else {
          const hints = pickingProject
            ? "↑↓  Enter open project  ·  / filter  ·  Q"
            : drilled
              ? "↑↓  Enter open  ·  P detail  ·  E export  ·  D del  ·  Esc back  ·  / filter  ·  Q"
              : mode === "delete"
                ? "↑↓  Enter delete  ·  P detail  ·  / filter  ·  Q"
                : mode === "select"
                  ? "↑↓  Enter select  ·  P detail  ·  D del  ·  / filter  ·  N ✎  ·  Q"
                  : "↑↓  Enter open  ·  P detail  ·  E export  ·  D del  ·  / filter  ·  N ✎  ·  Q";
          const filterTag = filter ? theme.fg("accent", `  "${filter}"`) : "";
          const annTag = onlyAnnotated ? theme.fg("accent", "  ✎ only") : "";
          lines.push(truncateToWidth(theme.fg("dim", hints) + filterTag + annTag, width));
        }

        // List body
        for (let row = 0; row < listHeight; row++) {
          const itemIndex = scrollOffset + Math.floor(row / ITEM_ROWS);
          const itemRow = row % ITEM_ROWS;

          if (itemIndex >= visible.length) {
            lines.push(" ".repeat(Math.max(0, width)));
            continue;
          }

          const item = visible[itemIndex];
          const isSelected = itemIndex === selectedIndex;
          // Marker only on the first message line — continuation and meta stay quiet indent.
          const marker = itemRow === 0 ? (isSelected ? theme.fg("accent", "› ") : "  ") : "  ";
          const bodyW = Math.max(8, width - 2);

          if (item.kind === "project") {
            if (itemRow === 0) {
              const label = item.title || item.projectLeaf || item.project;
              const text = isSelected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
              lines.push(truncateToWidth(marker + truncateToWidth(text, bodyW), width));
            } else if (itemRow === 1) {
              const pathLine = item.project || "";
              lines.push(truncateToWidth(marker + truncateToWidth(theme.fg("dim", pathLine), bodyW), width));
            } else {
              const n = item.sessionCount ?? 0;
              const count = n === 1 ? "1 session" : `${n} sessions`;
              const meta = [count, item.mtimeLabel, formatDateShort(item.mtime)].filter(Boolean).join("  ");
              lines.push(truncateToWidth(marker + truncateToWidth(theme.fg("dim", meta), bodyW), width));
            }
          } else if (itemRow === 0 || itemRow === 1) {
            let first: string;
            let second: string;
            if (item.annotation) {
              // Annotated: the generated title replaces the first message, the summary takes
              // the second line. Unannotated sessions keep the old first-message display.
              first = singleLine(item.annotation.title, bodyW);
              second = singleLine(item.annotation.summary, bodyW);
            } else {
              [first, second] = splitFirstLines(firstMessage(item), bodyW);
            }
            const raw = itemRow === 0 ? first : second;
            const rowMarker = itemRow === 1 && item.annotation ? theme.fg("accent", "✎ ") : marker;
            const styled =
              itemRow === 0
                ? isSelected
                  ? theme.fg("accent", theme.bold(raw))
                  : theme.fg("text", raw)
                : theme.fg("dim", raw || " ");
            lines.push(truncateToWidth(rowMarker + truncateToWidth(styled, bodyW), width));
          } else {
            // meta: 2h  746 KB  Aug 13 20:19  [projectLeaf if all-scope]
            const meta = buildMetaLine(item, showProject);
            lines.push(
              truncateToWidth(
                marker + truncateToWidth(theme.fg("dim", meta), bodyW),
                width,
              ),
            );
          }
        }

        // Footer
        let footer: string;
        if (isBusy) {
          footer = statusMsg || "…";
        } else if (pendingDelete) {
          footer = path.basename(pendingDelete.source_path);
        } else if (statusMsg) {
          footer = statusMsg;
        } else if (visible.length > 0) {
          const kind = pickingProject ? " projects" : "";
          footer = `${selectedIndex + 1}/${visible.length}` + (filter ? ` of ${items.length}` : "") + kind;
        } else {
          footer = filter ? `No matches · "${filter}"` : pickingProject ? "0 projects" : "0 sessions";
        }
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      }

      return component;
    },
    // Near-full-screen overlay: the 80-col default box wastes most of a wide terminal.
    { overlay: true, overlayOptions: { width: "95%" } },
  );
}

/** First message text for the 2-line list display; falls back to title/name. */
function firstMessage(item: BrowseItem): string {
  return item.firstUser || item.title || item.name || "";
}

/**
 * Word-wrap first message onto two list lines.
 * Line 1 is a full wrap (no "..."); line 2 gets "..." only when more remains.
 */
export function splitFirstLines(text: string, width: number): [string, string] {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return ["", ""];
  if (width < 1) return ["", ""];
  const wrapped = wrapTextWithAnsi(t, width);
  const first = wrapped[0] || "";
  if (wrapped.length <= 1) return [first, ""];
  const second = wrapped[1] || "";
  if (wrapped.length === 2) return [first, second];
  // More than two wrapped lines: keep line 1 intact, ellipsize line 2.
  if (width <= 3) return [first, second];
  const clipped = wrapTextWithAnsi(second, width - 3)[0] || "";
  return [first, clipped + "..."];
}

/** One clipped line; the tail is ellipsized when the text does not fit. */
export function singleLine(text: string, width: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || width < 1) return "";
  const full = wrapTextWithAnsi(t, width);
  if (full.length <= 1) return full[0] || "";
  if (width <= 3) return full[0] || "";
  return (wrapTextWithAnsi(t, width - 3)[0] || "") + "...";
}

/** "Aug 13 20:19" (same year) or "Aug 13 2025" — absolute companion to the relative label. */
export function formatDateShort(value: number | string | undefined): string {
  if (value === undefined || value === "") return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const sameYear = d.getFullYear() === new Date().getFullYear();
  if (sameYear) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
  }
  return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function buildMetaLine(item: BrowseItem, showProject: boolean): string {
  const parts: string[] = [];
  // Relative time + size + absolute date — tools are near-identical noise; see them in P detail.
  if (item.mtimeLabel) parts.push(item.mtimeLabel.padStart(3, " "));
  if (item.sizeLabel) parts.push(item.sizeLabel.padStart(7, " "));
  const abs = formatDateShort(item.mtime ?? (item.date ? item.date : undefined));
  if (abs) parts.push(abs);
  if (item.score !== undefined) parts.push(item.score.toFixed(2));
  if (showProject && item.projectLeaf) parts.push(item.projectLeaf);
  return parts.join("  ");
}

function renderSplitLine(left: string, right: string, width: number, _theme: any): string {
  if (!right) return truncateToWidth(left, width);
  const gap = 2;
  const rightW = visibleWidth(right);
  const leftMax = Math.max(0, width - rightW - gap);
  const leftTrim = truncateToWidth(left, leftMax);
  const pad = Math.max(gap, width - visibleWidth(leftTrim) - rightW);
  return truncateToWidth(leftTrim + " ".repeat(pad) + right, width);
}

function formatDate(date: string): string {
  if (!date) return "";
  return date.replace("T", " ").slice(0, 19);
}

function clip(text: string, limit: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit - 1) + "…";
}

function projectLeaf(project: string): string {
  if (!project) return "";
  const norm = project.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] || project;
}

/** Prefer human text; collapse bare paths to a short leaf. */
export function displayTitle(raw: string, fallback: string): string {
  const t = (raw || "").replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  // Windows / UNC / unix home paths as the whole title
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\") || /^~[/\\]/.test(t) || t.startsWith("/home/") || t.startsWith("/Users/")) {
    const leaf = t.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || fallback;
    return clip(leaf, 80);
  }
  return clip(t, 100);
}

function extractUserMessages(text: string): string[] {
  const matches = text.match(/\[User\]\s*(.+?)(?=\n\[|\n\[Assistant\]|\n\[ToolResult\]|$)/gs);
  if (!matches) return [];
  return matches
    .map((m) => m.replace(/^\[User\]\s*/, "").trim())
    .filter((m) => m.length > 0);
}

function extractAssistantMessages(text: string): string[] {
  const matches = text.match(/\[Assistant\]\s*(.+?)(?=\n\[|\n\[User\]|\n\[ToolResult\]|$)/gs);
  if (!matches) return [];
  return matches
    .map((m) => m.replace(/^\[Assistant\]\s*/, "").trim())
    .filter((m) => m.length > 0);
}

function extractToolCommands(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const tools = text.match(/\[ToolResult\]\s*(.+?)(?=\n\[|\n\[User\]|\n\[Assistant\]|$)/gs);
  if (tools) {
    for (const t of tools) {
      const body = t.replace(/^\[ToolResult\]\s*/, "").trim();
      const first = body.split(/\r?\n/)[0]?.trim();
      if (first && first.length > 3 && !seen.has(first)) {
        seen.add(first);
        out.push(first);
      }
    }
  }
  return out.slice(0, 3);
}

function pickBestTitle(users: string[]): string {
  if (users.length === 0) return "";
  const substantive = users.filter(
    (u) => u.length >= 12 && !/^\s*(hi|hello|hey|ok|okay|thanks|thx)\b/i.test(u),
  );
  const candidates = substantive.length > 0 ? substantive : users;
  // Prefer non-path messages
  const human = candidates.find((u) => !/^[A-Za-z]:[\\/]/.test(u.trim()));
  return displayTitle(human || candidates[0], "");
}

function buildSnippet(users: string[], assistants: string[], tools: string[]): string {
  const parts: string[] = [];
  if (users.length > 0) {
    parts.push(clip(users[users.length - 1], 220));
  }
  if (assistants.length > 0) {
    parts.push(clip(assistants[assistants.length - 1], 160));
  }
  if (parts.length === 0 && tools.length > 0) {
    parts.push("Tools: " + tools.join(" · "));
  }
  return parts.join("\n");
}

/** Map local list meta → browser row. */
export function browseItemFromMeta(m: LocalSessionMeta): BrowseItem {
  const project = m.project || extractProject(m.source_path);
  const date = formatDate(m.date);
  const mtimeLabel = formatMtimeLabel(m.mtime);
  const sizeLabel = formatSizeLabel(m.sizeBytes);
  const toolsLabel = m.tools.length ? m.tools.slice(0, 5).join(",") : undefined;
  const title = displayTitle(m.title || m.firstUser || "", path.basename(m.source_path, ".jsonl"));
  const snippet = m.firstUser || (toolsLabel ? `tools: ${toolsLabel}` : "");

  return {
    source_path: m.source_path,
    project,
    date,
    title,
    subtitle: [mtimeLabel, sizeLabel, toolsLabel].filter(Boolean).join("  "),
    snippet,
    name: m.name,
    annotation: m.annotation,
    sizeLabel,
    mtimeLabel,
    mtime: m.mtime,
    firstUser: m.firstUser,
    toolsLabel,
    projectLeaf: projectLeaf(project),
  };
}

/** Project picker row → browser row. */
export function browseItemFromProject(p: SessionProject): BrowseItem {
  const leaf = projectLeaf(p.project);
  return {
    kind: "project",
    source_path: p.dirName,
    dirName: p.dirName,
    project: p.project,
    date: "",
    title: leaf,
    subtitle: `${p.count}  ${formatMtimeLabel(p.mtime)}`,
    snippet: p.project,
    firstUser: p.project,
    sessionCount: p.count,
    mtime: p.mtime,
    mtimeLabel: formatMtimeLabel(p.mtime),
    projectLeaf: leaf,
  };
}

