/**
 * /keys — one custom() overlay. Do not nest ui.select/confirm inside it.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, isKeyRepeat, parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  backupIfAnnotated,
  compareBindings,
  defaultPath,
  formatKeys,
  groupOf,
  keysColWidth,
  keysOf,
  listDescWidth,
  padLabel,
  parseTypedKeys,
  sameKeys,
  toStored,
  writeOverrides,
  type Keys,
} from "./store.js";

type View = "changed" | "unbound" | "all";
type Mode = "list" | "filter" | "capture" | "type";

interface Kb {
  matches: (data: string, id: string) => boolean;
  getKeys: (id: string) => string[];
  getDefinition: (id: string) => { defaultKeys?: Keys; description?: string } | undefined;
  getConflicts: () => { key: string; keybindings: string[] }[];
  setUserBindings: (b: Record<string, Keys | undefined>) => void;
  getResolvedBindings: () => Record<string, Keys | undefined>;
  configPath?: string;
}

interface Binding {
  id: string;
  group: string;
  short: string;
  description: string;
  current: string[];
  defaults: string[];
  changed: boolean;
  unbound: boolean;
  conflict: string | undefined;
}

const VIEWS: View[] = ["changed", "unbound", "all"];
const HINT = "r rebind  a add  e type  x disable  u default  o view  / filter  ? more  q close";
const HINT_MORE = "r rebind  a add  e type  x disable  u default  o view  / filter  c next conflict  g/G top/end  q close";

function shortOf(id: string): string {
  const i = id.lastIndexOf(".");
  return i >= 0 ? id.slice(i + 1) : id;
}

function markOf(b: Binding): string {
  if (b.conflict) return "!";
  if (b.changed) return "*";
  return " ";
}

function collect(kb: Kb): Binding[] {
  const conflicts = new Map<string, string>();
  for (const c of kb.getConflicts()) {
    const others = c.keybindings;
    for (const id of others) {
      const rest = others.filter((x) => x !== id);
      const prev = conflicts.get(id);
      const bit = `${c.key} → ${rest.join(", ") || "?"}`;
      conflicts.set(id, prev ? `${prev}; ${bit}` : bit);
    }
  }
  const ids = Object.keys(kb.getResolvedBindings());
  return ids.map((id) => {
    const def = kb.getDefinition(id);
    const current = kb.getKeys(id);
    const defaults = keysOf(def?.defaultKeys);
    return {
      id,
      group: groupOf(id),
      short: shortOf(id),
      description: def?.description || id,
      current,
      defaults,
      changed: !sameKeys(current, defaults),
      unbound: current.length === 0,
      conflict: conflicts.get(id),
    };
  }).sort(compareBindings);
}

function compact(kb: Kb): Record<string, Keys> {
  const out: Record<string, Keys> = {};
  for (const b of collect(kb)) {
    if (b.changed) out[b.id] = toStored(b.current);
  }
  return out;
}

function printable(data: string): string | undefined {
  if (data.length === 1 && data >= " " && data <= "~") return data;
  return undefined;
}

export async function openKeybindsEditor(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;

  await ctx.ui.custom<void>((tui: TUI, theme: any, rawKb: unknown, done) => {
    const kb = rawKb as Kb;
    const path = defaultPath(kb);
    let view: View = "all";
    let mode: Mode = "list";
    let captureKind: "replace" | "add" = "replace";
    let filter = "";
    let buffer = "";
    let selected = 0;
    let scroll = 0;
    let status = "";
    let showHelp = false;
    let settled = false;

    function close(): void {
      if (settled) return;
      settled = true;
      done();
    }

    function rows(): Binding[] {
      const q = filter.trim().toLowerCase();
      return collect(kb).filter((b) => {
        if (view === "changed" && !b.changed) return false;
        if (view === "unbound" && !b.unbound) return false;
        if (!q) return true;
        return (
          b.id.toLowerCase().includes(q) ||
          b.short.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q) ||
          b.group.includes(q) ||
          b.current.join(" ").includes(q) ||
          b.defaults.join(" ").includes(q)
        );
      });
    }

    function current(): Binding | undefined {
      const list = rows();
      if (list.length === 0) return undefined;
      if (selected >= list.length) selected = list.length - 1;
      if (selected < 0) selected = 0;
      return list[selected];
    }

    function applyKeys(id: string, next: string[]): string {
      const all = collect(kb);
      const user: Record<string, Keys> = {};
      for (const b of all) {
        const keys = b.id === id ? next : b.current;
        if (!sameKeys(keys, b.defaults)) user[b.id] = toStored(keys);
      }
      try {
        const bak = backupIfAnnotated(path);
        writeOverrides(path, user);
        kb.setUserBindings(user);
        const n = Object.keys(user).length;
        return bak ? `saved ${n} overrides · backup ${bak}` : `saved ${n} overrides`;
      } catch (err) {
        return `save failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    function cycleView(): void {
      view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
      selected = 0;
      scroll = 0;
      status = "";
    }

    function render(width: number): string[] {
      const w = Math.max(20, width);
      const termRows = tui.terminal.rows || 24;
      // overlay chrome eats 2–3 rows; pin detail+hints so they cannot clip
      const maxLines = Math.max(10, termRows - 3);
      const titleN = 1;
      const detailN = 3;
      const hintN = 1;
      const bodyH = Math.max(3, maxLines - titleN - detailN - hintN);
      const list = rows();

      const visual: { kind: "g" | "i"; text: string; idx?: number }[] = [];
      const innerW = w - 2;
      const keyW = keysColWidth(list.map((b) => formatKeys(b.current)));
      const descW = listDescWidth(innerW, keyW);
      let lastGroup = "";
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.group !== lastGroup) {
          lastGroup = b.group;
          visual.push({ kind: "g", text: theme.fg("dim", `── ${b.group}`) });
        }
        const mark = markOf(b);
        const markCol = mark === "!" ? "error" : mark === "*" ? "warning" : "dim";
        const keysText = formatKeys(b.current);
        const keys = b.unbound
          ? theme.fg("dim", keysText)
          : b.changed
            ? theme.fg("accent", keysText)
            : keysText;
        const line =
          theme.fg(markCol, mark === " " ? " " : mark) +
          " " +
          padLabel(b.description, descW) +
          keys;
        visual.push({ kind: "i", text: line, idx: i });
      }

      let selVis = visual.findIndex((v) => v.kind === "i" && v.idx === selected);
      if (selVis < 0) selVis = 0;
      if (selVis < scroll) scroll = selVis;
      if (selVis >= scroll + bodyH) scroll = selVis - bodyH + 1;
      const maxScroll = Math.max(0, visual.length - bodyH);
      if (scroll > maxScroll) scroll = maxScroll;
      if (scroll < 0) scroll = 0;

      const allN = collect(kb).length;
      const changedN = collect(kb).filter((b) => b.changed).length;
      const pos = list.length ? `${selected + 1}/${list.length}` : "0/0";
      const title = theme.fg("accent", theme.bold?.("keybinds") ?? "keybinds");
      const meta = theme.fg("dim", ` ${view} · ${pos} · ${changedN} changed / ${allN}`);
      const out: string[] = [truncateToWidth(title + meta, w)];

      const slice = visual.slice(scroll, scroll + bodyH);
      while (slice.length < bodyH) slice.push({ kind: "g", text: "" });
      for (const row of slice) {
        const active = row.kind === "i" && row.idx === selected;
        const prefix = active ? theme.fg("accent", "▸") : " ";
        out.push(truncateToWidth(`${prefix} ${row.text || ""}`, w));
      }

      const b = current();
      const detail: string[] = ["", "", ""];
      if (mode === "capture") {
        detail[0] = theme.fg("warning", `PRESS A KEY to ${captureKind}  ${b ? b.id : ""}`);
        detail[1] = theme.fg("dim", "esc cancel — this key will not navigate");
        detail[2] = "";
      } else if (mode === "type") {
        detail[0] = theme.fg("warning", "type chords, comma-separated · enter save · esc cancel");
        detail[1] = theme.fg("accent", buffer || " ");
        detail[2] = theme.fg("dim", b ? `${b.id}  now ${formatKeys(b.current)}` : "");
      } else if (mode === "filter") {
        detail[0] = theme.fg("warning", `filter: ${filter}_`);
        detail[1] = theme.fg("dim", "enter keep · esc clear");
        detail[2] = "";
      } else if (b) {
        detail[0] = theme.fg("accent", b.id);
        detail[1] = `now ${formatKeys(b.current)}   ${theme.fg("dim", `default ${formatKeys(b.defaults)}`)}`;
        if (b.conflict) detail[2] = theme.fg("error", `conflict ${b.conflict}`);
        else if (status) detail[2] = theme.fg("accent", status);
        else detail[2] = "";
      } else {
        detail[0] = theme.fg("dim", filter ? "no matches" : `no ${view} bindings`);
        detail[1] = theme.fg("dim", "o cycle view · / filter · q close");
        detail[2] = status ? theme.fg("accent", status) : "";
      }
      for (const line of detail) out.push(truncateToWidth(line, w));

      const hints = showHelp ? HINT_MORE : HINT;
      out.push(truncateToWidth(theme.fg(mode === "capture" ? "warning" : "dim", hints), w));

      return out.slice(0, maxLines).map((line) => truncateToWidth(line, w));
    }

    function move(delta: number): void {
      const n = rows().length;
      if (n === 0) return;
      const next = selected + delta;
      if (next < 0) {
        selected = 0;
        return;
      }
      if (next >= n) {
        selected = n - 1;
        return;
      }
      selected = next;
    }

    function jumpConflict(): void {
      const list = rows();
      if (list.length === 0) return;
      for (let i = 1; i <= list.length; i++) {
        const idx = (selected + i) % list.length;
        if (list[idx].conflict) {
          selected = idx;
          status = "";
          return;
        }
      }
      status = "no conflicts in view";
    }

    function startCapture(kind: "replace" | "add"): void {
      if (!current()) return;
      mode = "capture";
      captureKind = kind;
      status = "";
    }

    function startType(): void {
      const b = current();
      if (!b) return;
      mode = "type";
      buffer = b.current.join(", ");
      status = "";
    }

    function commitKeys(next: string[]): void {
      const b = current();
      if (!b) return;
      const uniq: string[] = [];
      for (const k of next) {
        if (!uniq.includes(k)) uniq.push(k);
      }
      status = applyKeys(b.id, uniq);
      mode = "list";
      buffer = "";
    }

    function handleCapture(data: string): void {
      if (isKeyRelease(data) || isKeyRepeat(data)) return;
      const key = parseKey(data);
      if (!key) return;
      if (key === "escape") {
        mode = "list";
        status = "cancelled";
        return;
      }
      const b = current();
      if (!b) {
        mode = "list";
        return;
      }
      if (captureKind === "add") commitKeys([...b.current, key]);
      else commitKeys([key]);
    }

    function handleType(data: string): void {
      const key = parseKey(data);
      if (key === "escape") {
        mode = "list";
        buffer = "";
        status = "cancelled";
        return;
      }
      if (key === "enter") {
        const parsed = parseTypedKeys(buffer);
        if (parsed === undefined) {
          status = "bad chord (example: ctrl+shift+c or left, ctrl+b)";
          return;
        }
        commitKeys(parsed);
        return;
      }
      if (key === "backspace") {
        buffer = buffer.slice(0, -1);
        return;
      }
      const ch = printable(data);
      if (ch) buffer += ch;
    }

    function handleFilter(data: string): void {
      const key = parseKey(data);
      if (key === "escape") {
        filter = "";
        mode = "list";
        selected = 0;
        return;
      }
      if (key === "enter") {
        mode = "list";
        selected = 0;
        return;
      }
      if (key === "backspace") {
        filter = filter.slice(0, -1);
        selected = 0;
        return;
      }
      const ch = printable(data);
      if (ch) {
        filter += ch;
        selected = 0;
      }
    }

    function handleList(data: string): void {
      const key = parseKey(data);
      if (!key) return;

      if (key === "escape" || key === "q") {
        close();
        return;
      }
      if (key === "/") {
        mode = "filter";
        status = "";
        return;
      }
      if (key === "?" || key === "shift+/") {
        showHelp = !showHelp;
        return;
      }
      if (key === "o") {
        cycleView();
        return;
      }
      if (key === "g") {
        selected = 0;
        return;
      }
      if (key === "G" || key === "shift+g") {
        selected = Math.max(0, rows().length - 1);
        return;
      }
      if (key === "c") {
        jumpConflict();
        return;
      }
      if (key === "up" || key === "k") {
        move(-1);
        return;
      }
      if (key === "down" || key === "j") {
        move(1);
        return;
      }
      if (key === "pageUp") {
        move(-10);
        return;
      }
      if (key === "pageDown") {
        move(10);
        return;
      }
      if (key === "r") {
        startCapture("replace");
        return;
      }
      if (key === "a") {
        startCapture("add");
        return;
      }
      if (key === "e") {
        startType();
        return;
      }
      if (key === "x") {
        const b = current();
        if (b) status = applyKeys(b.id, []);
        return;
      }
      if (key === "u") {
        const b = current();
        if (b) status = applyKeys(b.id, [...b.defaults]);
        return;
      }
    }

    return {
      render,
      invalidate: () => {},
      handleInput: (data: string) => {
        if (settled) return;
        if (isKeyRelease(data)) return;
        if (mode === "capture") handleCapture(data);
        else if (mode === "type") handleType(data);
        else if (mode === "filter") handleFilter(data);
        else handleList(data);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "95%" } });
}
