import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { roleFamily } from "./roles.js";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "roleSwitcher";

export interface RoleSwitcherSettings {
  /** How to pick the role when no role is saved in the session. */
  defaultMode: "fixed" | "latest";
  /** Role name used when `defaultMode` is `"fixed"`. */
  fixedRole: string;
  /** Map of model key (`providerId::modelId`) to role name. */
  modelRoleMap: Record<string, string>;
}

const DEFAULT_SETTINGS: RoleSwitcherSettings = {
  defaultMode: "fixed",
  fixedRole: "",
  modelRoleMap: {},
};

/**
 * Normalize any stored role name to its family alias: `agent-core-v3` → `agent-core`.
 * Stored settings and session entries keep aliases, so a version bump never
 * needs a config edit. Plain role names (`sub-default`) pass through untouched.
 */
export function normalizeRoleName(name: string): string {
  return roleFamily(name.trim().replace(/\.md$/i, ""));
}

/** Build a canonical map key for a model. */
export function modelRoleMapKey(model: Model<any> | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}::${model.id}`;
}

/** Resolve a role for a model using the map. */
export function resolveRoleForModel(
  model: Model<any> | undefined,
  map: Record<string, string>,
): string | undefined {
  if (!model) return undefined;
  return map[modelRoleMapKey(model)] ?? map[model.id];
}

/**
 * Pick the startup role, always as a family alias.
 * Priority:
 * 1. Role saved in the session (manual /role or a previous model_select
 *    auto-switch) — it must survive resume. Versioned entries saved by older
 *    builds (`agent-core-v3`) normalize to the family and follow the bump.
 * 2. Model map for the current model (new sessions, or saved role deleted).
 * 3. Configured default role.
 * Returns `fromSession: true` when the session role wins — callers must NOT
 * re-persist it (it is already in the session) and must NOT override it with
 * the model map.
 */
export function pickRoleForStartup(opts: {
  savedRole: string | null;
  available: string[];
  settings: RoleSwitcherSettings;
  model: Model<any> | undefined;
  defaultRole: string;
}): { role: string; fromSession: boolean } {
  const saved = opts.savedRole ? normalizeRoleName(opts.savedRole) : null;
  if (saved && opts.available.includes(saved)) {
    return { role: saved, fromSession: true };
  }
  const mapped = resolveRoleForModel(opts.model, opts.settings.modelRoleMap);
  const mappedAlias = mapped ? normalizeRoleName(mapped) : null;
  if (mappedAlias && opts.available.includes(mappedAlias)) {
    return { role: mappedAlias, fromSession: false };
  }
  return { role: normalizeRoleName(opts.defaultRole), fromSession: false };
}

/**
 * Find the last role-switcher entry in a branch entry list (oldest → newest).
 * Returns the saved role name or null when the branch has no role record.
 */
export function findSavedRole(entries: readonly { type?: string; customType?: string; data?: any }[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e.customType === "role-switcher") {
      return e.data?.role ?? null;
    }
  }
  return null;
}

export function loadSettingsFile(): any {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

/** @returns true if settings.json was written successfully */
export function saveSettingsFile(settings: any): boolean {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  } catch (err) {
    console.error(`[role-sw] Failed to save settings to ${SETTINGS_PATH}: ${err}`);
    return false;
  }
}

function normalizeModelRoleMap(raw: any): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === "string") {
      map[key] = raw[key];
    }
  }
  return map;
}

export function loadRoleSwitcherSettings(): RoleSwitcherSettings {
  const settings = loadSettingsFile();
  const raw = settings[SETTINGS_KEY];
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_SETTINGS };
  }
  const mode = raw.defaultMode === "latest" ? "latest" : "fixed";
  const fixed = typeof raw.fixedRole === "string" && raw.fixedRole.length > 0
    ? raw.fixedRole
    : DEFAULT_SETTINGS.fixedRole;
  const modelRoleMap = normalizeModelRoleMap(raw.modelRoleMap);
  return { defaultMode: mode, fixedRole: fixed, modelRoleMap };
}

/**
 * Merge and persist roleSwitcher settings.
 * @throws if settings.json cannot be written (callers should surface the error).
 */
export function saveRoleSwitcherSettings(partial: Partial<RoleSwitcherSettings>): RoleSwitcherSettings {
  const current = loadRoleSwitcherSettings();
  const next: RoleSwitcherSettings = {
    defaultMode: partial.defaultMode ?? current.defaultMode,
    fixedRole: partial.fixedRole ?? current.fixedRole,
    modelRoleMap: normalizeModelRoleMap(partial.modelRoleMap ?? current.modelRoleMap),
  };
  const settings = loadSettingsFile();
  settings[SETTINGS_KEY] = next;
  if (!saveSettingsFile(settings)) {
    throw new Error(`Failed to write ${SETTINGS_PATH}`);
  }
  return next;
}
