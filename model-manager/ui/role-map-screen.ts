import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelManagerConfig } from "../types.js";
import { getDefaultModelForProvider } from "../provider-utils.js";
import { loadModelNotes, getModelNote, type ModelNotes } from "../model-notes.js";
import { loadRoleSwitcherSettings, saveRoleSwitcherSettings, modelRoleMapKey, normalizeRoleName } from "../../role-sw/config.js";
import { getAvailableRoles } from "../../role-sw/roles.js";

interface FavoriteModel {
  key: string;
  model: Model<any>;
}

/**
 * Stored role value normalized to its family alias, or undefined when unmapped.
 * The list here holds aliases (`agent-core`), so a stale concrete version must
 * be compared as its alias — otherwise the row shows no ✓ and Enter clears it.
 */
function normalizeStoredRole(value: string | undefined): string | undefined {
  return value ? normalizeRoleName(value) : undefined;
}

export interface RoleMapScreenOptions {
  /** Prefer focusing this map key (`provider::modelId`) after load. */
  focusKey?: string;
  /** When true and focusKey resolves, open the role picker immediately. */
  autoOpenRolePicker?: boolean;
}

export class RoleMapScreen {
  private tui: TUI;
  private theme: Theme;
  private ctx: ExtensionContext | ExtensionCommandContext;
  private config: ModelManagerConfig;
  private onDone: () => void;
  private notes: ModelNotes;
  private models: FavoriteModel[] = [];
  private roles: string[] = [];
  private mode: "models" | "roles" = "models";
  private selectedIndex = 0;
  private modelIndexBeforeRoles = 0;
  private selectedModelKey?: string;
  private focusKey?: string;
  private autoOpenRolePicker = false;

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    ctx: ExtensionContext | ExtensionCommandContext,
    config: ModelManagerConfig,
    onDone: () => void,
    options?: RoleMapScreenOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.config = config;
    this.onDone = onDone;
    this.focusKey = options?.focusKey;
    this.autoOpenRolePicker = options?.autoOpenRolePicker ?? false;
    this.notes = loadModelNotes();
    this.load().catch((err) => {
      console.error(`[model-manager] failed to load role map screen: ${err}`);
      if (this.ctx.hasUI) this.ctx.ui.notify("Failed to load role map", "error");
    });
  }

  invalidate(): void {}

  private async load(): Promise<void> {
    const roleSettings = loadRoleSwitcherSettings();
    const availableRoles = await getAvailableRoles();
    this.roles = ["(no mapping)", ...availableRoles];

    const seen = new Set<string>();
    const models: FavoriteModel[] = [];
    for (const fav of this.config.favorites) {
      const model = fav.modelId
        ? this.ctx.modelRegistry.find(fav.providerId, fav.modelId)
        : getDefaultModelForProvider(this.ctx, fav.providerId);
      if (!model) continue;
      const key = modelRoleMapKey(model);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      models.push({ key, model });
    }
    this.models = models;
    if (this.focusKey) {
      const idx = this.models.findIndex((m) => m.key === this.focusKey);
      if (idx >= 0) {
        this.selectedIndex = idx;
        if (this.autoOpenRolePicker) {
          this.enterRoleMode(this.models[idx].key);
          this.tui.requestRender();
          return;
        }
      }
    }
    if (this.selectedIndex >= this.models.length) {
      this.selectedIndex = Math.max(0, this.models.length - 1);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.mode === "roles") {
      return this.renderRoles(width);
    }
    return this.renderModels(width);
  }

  private renderModels(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Model Manager > Role Mappings")), width));
    lines.push(this.theme.fg("dim", "Only pinned favorites are shown"));
    lines.push("");

    if (this.models.length === 0) {
      lines.push(this.theme.fg("dim", "  No favorite models to map — pin some with *"));
      lines.push("");
      lines.push(truncateToWidth(this.theme.fg("dim", "Esc back"), width));
      return lines;
    }

    const roleSettings = loadRoleSwitcherSettings();
    const maxVisible = 18;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.models.length - maxVisible));
    const end = Math.min(start + maxVisible, this.models.length);

    for (let i = start; i < end; i++) {
      const { key, model } = this.models[i];
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      const providerName = this.ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
      const note = getModelNote(this.notes, model.provider, model.id);
      const currentRole = normalizeStoredRole(roleSettings.modelRoleMap[key]);
      const name = selected ? this.theme.fg("accent", model.name ?? model.id) : this.theme.fg("text", model.name ?? model.id);
      const meta = [`${providerName}${note ? ` · "${note}"` : ""}`, currentRole ? `→ ${currentRole}` : "no mapping"]
        .filter(Boolean)
        .join(" · ");
      const line = `${prefix}${name} ${this.theme.fg("dim", meta)}`;
      lines.push(truncateToWidth(line, width));
    }

    if (start > 0 || end < this.models.length) {
      lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.models.length})`));
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ move · Enter map role · Esc back"), width));
    return lines;
  }

  private renderRoles(width: number): string[] {
    const lines: string[] = [];
    const modelName = this.selectedModelKey
      ? (this.models.find((m) => m.key === this.selectedModelKey)?.model.name ?? this.selectedModelKey)
      : "";
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Role for ${modelName}`)), width));
    lines.push("");

    if (this.roles.length === 0) {
      lines.push(this.theme.fg("dim", "  Loading roles..."));
      return lines;
    }

    const roleSettings = loadRoleSwitcherSettings();
    const currentRole = normalizeStoredRole(this.selectedModelKey ? roleSettings.modelRoleMap[this.selectedModelKey] : undefined);
    for (let i = 0; i < this.roles.length; i++) {
      const role = this.roles[i];
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      const label = role === "(no mapping)" ? this.theme.fg("dim", "(no mapping)") : this.theme.fg("text", role);
      const marker = role === currentRole ? this.theme.fg("success", " ✓") : "";
      lines.push(truncateToWidth(`${prefix}${label}${marker}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ move · Enter set role · Esc back"), width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (this.mode === "roles") {
      this.handleRolesInput(data, kb);
      return;
    }
    this.handleModelsInput(data, kb);
  }

  private handleModelsInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.models.length === 0 ? 0 : (this.selectedIndex === 0 ? this.models.length - 1 : this.selectedIndex - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.models.length === 0 ? 0 : (this.selectedIndex === this.models.length - 1 ? 0 : this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.models[this.selectedIndex];
      if (selected) {
        this.enterRoleMode(selected.key);
      }
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onDone();
      return;
    }
    this.tui.requestRender();
  }

  private handleRolesInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.roles.length === 0 ? 0 : (this.selectedIndex === 0 ? this.roles.length - 1 : this.selectedIndex - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.roles.length === 0 ? 0 : (this.selectedIndex === this.roles.length - 1 ? 0 : this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.saveRole();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.leaveRoleMode();
    }
    this.tui.requestRender();
  }

  private enterRoleMode(modelKey: string): void {
    this.selectedModelKey = modelKey;
    this.modelIndexBeforeRoles = this.selectedIndex;
    const roleSettings = loadRoleSwitcherSettings();
    // Normalized: a stored concrete version (`agent-core-v3`) must still match
    // the alias listed here, else Enter would silently drop the mapping.
    const currentRole = normalizeStoredRole(roleSettings.modelRoleMap[modelKey]);
    this.selectedIndex = currentRole ? Math.max(0, this.roles.indexOf(currentRole)) : 0;
    this.mode = "roles";
  }

  private leaveRoleMode(): void {
    this.mode = "models";
    this.selectedModelKey = undefined;
    this.selectedIndex = this.modelIndexBeforeRoles;
  }

  private saveRole(): void {
    if (!this.selectedModelKey) return;
    const role = this.roles[this.selectedIndex];
    if (!role) return;
    const roleSettings = loadRoleSwitcherSettings();
    const nextMap = { ...roleSettings.modelRoleMap };
    if (role === "(no mapping)") {
      delete nextMap[this.selectedModelKey];
    } else {
      nextMap[this.selectedModelKey] = role;
    }
    try {
      saveRoleSwitcherSettings({ modelRoleMap: nextMap });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.ctx.hasUI) this.ctx.ui.notify(`Failed to save role mapping: ${msg}`, "error");
      return;
    }
    if (this.ctx.hasUI) {
      this.ctx.ui.notify(
        `Saved: ${this.selectedModelKey} → ${role === "(no mapping)" ? "none" : role}`,
        "info",
      );
    }
    this.leaveRoleMode();
  }
}
