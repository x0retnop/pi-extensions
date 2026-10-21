/**
 * keybindings.json — sparse overrides only.
 * Annotated full dumps are backed up once, then compacted on first save.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEYBINDS_PATH = join(homedir(), ".pi", "agent", "keybindings.json");
export const KEYBINDS_BAK = join(homedir(), ".pi", "agent", "keybindings.json.bak");

export const NOTE = "Overrides only. Edit via /keys. [] = disabled. Missing key = Pi default.";

export type Keys = string | string[];

export function keysOf(value: Keys | undefined | null): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter((k) => typeof k === "string") : [value];
}

export function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((k, i) => k === sb[i]);
}

export function toStored(keys: string[]): Keys {
  return keys.length <= 1 ? (keys[0] ?? []) : [...keys];
}

export function formatKeys(keys: string[]): string {
  return keys.length === 0 ? "off" : keys.join(", ");
}

/** Display group for a binding id. Order is GROUP_RANK — keep session/tree together. */
export function groupOf(id: string): string {
  if (id.startsWith("tui.editor.")) return "editor";
  if (id.startsWith("tui.input.")) return "input";
  if (id.startsWith("tui.select.")) return "menus";
  if (id.startsWith("tui.altScreen.")) return "scroll";
  if (id.startsWith("app.tree.filter.")) return "tree filter";
  if (id.startsWith("app.tree.")) return "tree";
  if (id.startsWith("app.session.")) return "session";
  if (id.startsWith("app.models.")) return "model picker";
  if (id.startsWith("app.model.")) return "model";
  if (id.startsWith("app.thinking.")) return "thinking";
  if (id.startsWith("app.message.")) return "message";
  if (id.startsWith("app.clipboard.")) return "clipboard";
  if (id.startsWith("app.tools.")) return "tools";
  if (id.startsWith("app.editor.")) return "external editor";
  if (id.startsWith("app.")) return "app";
  if (id.startsWith("tui.")) return "tui";
  return "other";
}

const GROUP_RANK: Record<string, number> = {
  app: 0,
  thinking: 1,
  model: 2,
  message: 3,
  clipboard: 4,
  tools: 5,
  "external editor": 6,
  session: 7,
  tree: 8,
  "tree filter": 9,
  "model picker": 10,
  editor: 11,
  input: 12,
  menus: 13,
  scroll: 14,
  tui: 15,
  other: 16,
};

export function groupRank(group: string): number {
  return GROUP_RANK[group] ?? 99;
}

export function compareBindings(a: { group: string; id: string }, b: { group: string; id: string }): number {
  const d = groupRank(a.group) - groupRank(b.group);
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

/** Keys column width for a list of already-formatted key strings (`off`, `ctrl+p`). */
export function keysColWidth(keyStrings: string[]): number {
  let m = 3;
  for (const s of keyStrings) {
    if (s.length > m) m = s.length;
  }
  return Math.min(34, Math.max(8, m));
}

/** Description column after `▸ ` + mark + space. */
export function listDescWidth(innerW: number, keyW: number): number {
  return Math.max(8, innerW - 2 - keyW);
}

export function padLabel(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

export function defaultPath(kb: { configPath?: string } | null | undefined): string {
  const fromKb = typeof kb?.configPath === "string" ? kb.configPath : "";
  return fromKb || KEYBINDS_PATH;
}

/** True when the on-disk file still has `_id` comment keys (the old annotated dump). */
export function isAnnotatedDump(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => k.startsWith("_") && k !== "_note");
}

export function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore — caller treats as empty / will overwrite on save
  }
  return {};
}

/** Copy annotated dump to .bak once. Returns the bak path only when it created one. */
export function backupIfAnnotated(path: string): string | undefined {
  const raw = readRaw(path);
  if (!isAnnotatedDump(raw)) return undefined;
  if (existsSync(KEYBINDS_BAK)) return undefined;
  copyFileSync(path, KEYBINDS_BAK);
  return KEYBINDS_BAK;
}

export function writeOverrides(path: string, overrides: Record<string, Keys>): void {
  const body: Record<string, unknown> = { _note: NOTE };
  for (const id of Object.keys(overrides).sort()) {
    body[id] = overrides[id];
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function parseTypedKeys(raw: string): string[] | undefined {
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const mods = new Set(["ctrl", "shift", "alt", "super"]);
  for (const part of parts) {
    const bits = part.split("+").filter(Boolean);
    if (bits.length === 0) return undefined;
    const key = bits[bits.length - 1];
    if (!key) return undefined;
    for (const m of bits.slice(0, -1)) {
      if (!mods.has(m)) return undefined;
    }
  }
  return parts;
}
