import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { setStatusBlock } from "../common/status.js";
import { loadRoleSwitcherSettings, saveRoleSwitcherSettings, pickRoleForStartup, resolveRoleForModel, findSavedRole, normalizeRoleName } from "./config.js";
import { getAvailableRoles, getLatestRole, resolveRole, readRole, ROLES_DIR } from "./roles.js";
import { SENTINEL_ALARM, composeInteractivePrompt } from "./sentinel.js";

// ANSI color for the role status entry (purple-ish, survives footer sanitizer).
const ANSI_ROLE = "\x1b[38;5;141m";
const ANSI_RESET = "\x1b[0m";
const fmtRole = (s: string): string => `${ANSI_ROLE}${s}${ANSI_RESET}`;

/**
 * Status label for a role name. Always the concrete file name
 * (`role:agent-core-v4`), so a version bump is visible without opening files.
 */
function roleStatus(alias: string): string {
  const ref = resolveRole(alias);
  return fmtRole(`role:${ref ? ref.name : alias || "none"}`);
}

/** Default role as a family alias. `latest` mode = newest file's family by mtime. */
async function resolveDefaultRole(settings: ReturnType<typeof loadRoleSwitcherSettings>): Promise<string> {
  const available = await getAvailableRoles();

  if (settings.defaultMode === "fixed") {
    const fixed = normalizeRoleName(settings.fixedRole);
    if (fixed && available.includes(fixed)) return fixed;
    // Nothing configured, or the family was deleted — deterministic fallback.
    return available[0] ?? "";
  }

  const latest = await getLatestRole();
  const latestAlias = latest ? normalizeRoleName(latest) : null;
  if (latestAlias && available.includes(latestAlias)) return latestAlias;

  return available[0] ?? "";
}

export default function (pi: ExtensionAPI) {
  // ── Sub-agent child mode ──
  // Inside a sub-agents child process (PI_SUB_AGENTS_CHILD=1) role-sw does not
  // append the interactive role. Instead it composes the ENTIRE system prompt:
  //   <role file (PI_SUB_AGENT_ROLE)> + <agent body (PI_SUB_AGENT_PROMPT_FILE)> + cwd
  // No role requested → keep the default Pi prompt (agent body already in
  // --append-system-prompt). Role requested but missing/empty → alarm only.
  if (process.env.PI_SUB_AGENTS_CHILD === "1") {
    pi.on("before_agent_start", async (event, ctx) => {
      const roleName = process.env.PI_SUB_AGENT_ROLE?.trim();
      if (!roleName) return;

      const roleRef = resolveRole(roleName);
      const rolePrompt = roleRef ? await readRole(roleRef.path) : null;
      if (!rolePrompt || !rolePrompt.trim()) {
        return { systemPrompt: SENTINEL_ALARM };
      }

      const parts = [rolePrompt.trim()];

      const promptFile = process.env.PI_SUB_AGENT_PROMPT_FILE?.trim();
      if (promptFile) {
        try {
          const body = (await readFile(promptFile, "utf-8")).trim();
          if (body) parts.push(body);
        } catch {
          // missing prompt file — role alone is still usable
        }
      }

      parts.push(`Current working directory: ${ctx.cwd}`);
      return { systemPrompt: parts.join("\n\n") };
    });
    return;
  }

  // Always a family alias (`agent-core`), never a concrete versioned file:
  // the file is re-resolved on every before_agent_start, so dropping a new
  // version and deleting the old one takes effect on the next message.
  let activeRole = "";

  function applyRole(
    role: string,
    ctx: { hasUI?: boolean; ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
    opts?: { persist?: boolean; notify?: string },
  ): boolean {
    if (!role || role === activeRole) {
      setStatusBlock(ctx, "role", roleStatus(activeRole));
      return false;
    }
    activeRole = role;
    if (opts?.persist !== false) {
      pi.appendEntry("role-switcher", { role: activeRole, switchedAt: Date.now() });
    }
    setStatusBlock(ctx, "role", roleStatus(activeRole));
    if (opts?.notify && ctx.hasUI) {
      ctx.ui?.notify?.(opts.notify, "info");
    }
    return true;
  }

  // ── Restore role from session on start / reload / resume ──
  pi.on("session_start", async (_event, ctx) => {
    const settings = loadRoleSwitcherSettings();
    const available = await getAvailableRoles();

    // Last role saved in the current branch (manual /role or a model_select
    // auto-switch). getBranch() walks root→leaf, so it only sees this branch —
    // getEntries() would leak role records from sibling branches.
    const savedRole = findSavedRole(ctx.sessionManager.getBranch());

    const { role, fromSession } = pickRoleForStartup({
      savedRole,
      available,
      settings,
      model: ctx.model,
      defaultRole: await resolveDefaultRole(settings),
    });

    if (fromSession) {
      // Session role wins over the model map on resume — the user's explicit
      // choice (or a previous auto-switch) must not be clobbered by the map.
      // Not persisted again: it is already the last role-switcher entry.
      activeRole = role;
      setStatusBlock(ctx, "role", roleStatus(activeRole));
      return;
    }

    // No usable session role: apply the model map (new session), else default.
    applyRole(role, ctx, {
      persist: role !== activeRole,
      notify:
        role !== activeRole
          ? `Role ${resolveRole(role)?.name ?? role} for ${ctx.model?.name ?? ctx.model?.id ?? "model"}`
          : undefined,
    });
  });

  // ── Restore role when navigating to another branch (/tree) ──
  pi.on("session_tree", async (_event, ctx) => {
    const savedRole = findSavedRole(ctx.sessionManager.getBranch());
    if (!savedRole) return; // branch has no role record — keep the current role

    // Normalize: entries written by older builds carry concrete versions
    // (`agent-core-v3`) and must follow the current file.
    const alias = normalizeRoleName(savedRole);
    const ref = resolveRole(alias);
    if (!ref) {
      // Whole family gone — keep the current role instead of guessing.
      return;
    }

    activeRole = alias;
    setStatusBlock(ctx, "role", roleStatus(activeRole));
  });

  // ── Auto-switch role when the active model changes ──
  pi.on("model_select", async (event, ctx) => {
    const settings = loadRoleSwitcherSettings();
    const mapped = resolveRoleForModel(event.model, settings.modelRoleMap);
    if (!mapped) return; // unmapped model: keep manual /role (or previous)
    const alias = normalizeRoleName(mapped);
    // Don't apply a role whose file doesn't exist (protects against stale entries)
    const ref = resolveRole(alias);
    if (!ref) return;
    applyRole(alias, ctx, {
      notify: `Auto-switched role to ${ref.name} for ${event.model.name ?? event.model.id}`,
    });
  });

  // ── Replace SYSTEM.md canary with role + remaining base (AGENTS/cwd/date) ──
  pi.on("before_agent_start", async (event, ctx) => {
    // Re-resolved every agent run: a freshly added version file is picked up
    // without a Pi restart, as soon as the old one is gone.
    const ref = resolveRole(activeRole);
    if (!ref) {
      const missing = `${ROLES_DIR}/${activeRole || "<none>"}.md`;
      setStatusBlock(ctx, "role", roleStatus(activeRole));
      ctx.ui.notify(`Role file not found: ${missing}`, "warning");
      return { systemPrompt: composeInteractivePrompt(null, event.systemPrompt ?? "") };
    }

    const rolePrompt = await readRole(ref.path);
    const trimmed = rolePrompt?.trim() ?? "";
    if (!trimmed) {
      ctx.ui.notify(`Role file empty: ${ref.path}`, "warning");
      return { systemPrompt: composeInteractivePrompt(null, event.systemPrompt ?? "") };
    }

    setStatusBlock(ctx, "role", roleStatus(activeRole));
    return { systemPrompt: composeInteractivePrompt(trimmed, event.systemPrompt ?? "") };
  });

  // ── /role [<name>] ──
  pi.registerCommand("role", {
    description: "Switch agent role",
    handler: async (args, ctx) => {
      const available = await getAvailableRoles();
      if (available.length === 0) {
        ctx.ui.notify(`No role files found in ${ROLES_DIR}`, "error");
        return;
      }

      const requested = args.trim().toLowerCase().replace(/\.md$/, "");

      // With argument — switch directly. A concrete version (`agent-core-v3`)
      // is accepted but normalized to the family, so a bump is never pinned.
      if (requested) {
        const ref = resolveRole(requested);
        if (!ref) {
          ctx.ui.notify(
            `Unknown role "${requested}". Available: ${available.join(", ")}`,
            "error"
          );
          return;
        }
        activeRole = ref.alias;
        pi.appendEntry("role-switcher", { role: activeRole, switchedAt: Date.now() });
        setStatusBlock(ctx, "role", roleStatus(activeRole));
        ctx.ui.notify(`Switched to role: ${ref.name}`, "info");
        return;
      }

      // Without argument — TUI select
      if (!ctx.hasUI) {
        ctx.ui.notify(`Current role: ${resolveRole(activeRole)?.name ?? activeRole}. Available: ${available.join(", ")}`, "info");
        return;
      }

      const choice = await ctx.ui.select(
        `Select role (current: ${resolveRole(activeRole)?.name ?? activeRole})`,
        available
      );

      if (!choice || !available.includes(choice)) return;

      activeRole = choice;
      pi.appendEntry("role-switcher", { role: activeRole, switchedAt: Date.now() });
      setStatusBlock(ctx, "role", roleStatus(activeRole));
      ctx.ui.notify(`Switched to role: ${resolveRole(activeRole)?.name ?? activeRole}`, "info");
    },
  });

  // ── /role-config [latest | fixed <role>] ──
  pi.registerCommand("role-config", {
    description: "Configure default role selection mode",
    handler: async (args, ctx) => {
      const available = await getAvailableRoles();
      if (available.length === 0) {
        ctx.ui.notify(`No role files found in ${ROLES_DIR}`, "error");
        return;
      }

      const argv = args.trim().toLowerCase();
      let settings = loadRoleSwitcherSettings();

      // CLI forms: /role-config latest | /role-config fixed <role>
      try {
        if (argv === "latest") {
          settings = saveRoleSwitcherSettings({ defaultMode: "latest" });
          const latest = await getLatestRole();
          ctx.ui.notify(`Default role mode: latest file (${latest ?? "none"})`, "info");
          return;
        }

        const fixedMatch = argv.match(/^fixed\s+(\S+)$/);
        if (fixedMatch) {
          const ref = resolveRole(fixedMatch[1].replace(/\.md$/, ""));
          if (!ref) {
            ctx.ui.notify(`Unknown role "${fixedMatch[1]}". Available: ${available.join(", ")}`, "error");
            return;
          }
          settings = saveRoleSwitcherSettings({ defaultMode: "fixed", fixedRole: ref.alias });
          ctx.ui.notify(`Default role mode: fixed = ${ref.alias} (${ref.name})`, "info");
          return;
        }

        // Show current mode if no UI
        if (!ctx.hasUI) {
          const modeText = settings.defaultMode === "latest"
            ? `latest file (${await getLatestRole() ?? "none"})`
            : `fixed = ${settings.fixedRole} (${resolveRole(settings.fixedRole)?.name ?? "missing"})`;
          ctx.ui.notify(`Default role mode: ${modeText}. Use /role-config latest or /role-config fixed <role>`, "info");
          return;
        }

        // TUI
        const modeChoice = await ctx.ui.select(
          `Select default role mode (current: ${settings.defaultMode})`,
          ["Smart latest — most recent role file", "Fixed — always start with chosen role"]
        );
        if (!modeChoice) return;

        if (modeChoice.startsWith("Smart latest")) {
          saveRoleSwitcherSettings({ defaultMode: "latest" });
          const latest = await getLatestRole();
          ctx.ui.notify(`Default role mode: latest file (${latest ?? "none"})`, "info");
          return;
        }

        const roleChoice = await ctx.ui.select(
          `Select fixed default role (current: ${settings.fixedRole || "none"})`,
          available
        );
        if (!roleChoice || !available.includes(roleChoice)) return;

        saveRoleSwitcherSettings({ defaultMode: "fixed", fixedRole: roleChoice });
        ctx.ui.notify(`Default role mode: fixed = ${roleChoice} (${resolveRole(roleChoice)?.name ?? "missing"})`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to save role settings: ${msg}`, "error");
      }
    },
  });
}
