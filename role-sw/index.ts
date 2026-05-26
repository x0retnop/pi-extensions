import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════
//  CONFIG — 4 hard-coded roles loaded from ~/.pi/agent/roles
// ═══════════════════════════════════════════════════════════
const ROLES: Record<string, string> = {
  architect_planner: join(homedir(), ".pi", "agent", "roles", "architect_planner.md"),
  code_auditor:      join(homedir(), ".pi", "agent", "roles", "code_auditor.md"),
  coding_agent:      join(homedir(), ".pi", "agent", "roles", "coding_agent.md"),
  kimi:              join(homedir(), ".pi", "agent", "roles", "kimi.md"),
  project_keeper:    join(homedir(), ".pi", "agent", "roles", "project_keeper.md"),
};

const DEFAULT_ROLE = "kimi";

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

async function readRole(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    const cached = cache.get(path);
    if (cached && cached.mtime === s.mtime.getTime()) {
      return cached.content;
    }
    const content = await readFile(path, "utf-8");
    cache.set(path, { content, mtime: s.mtime.getTime() });
    return content;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let activeRole = DEFAULT_ROLE;

  // ── Restore role from session on start / reload / resume ──
  pi.on("session_start", async (_event, ctx) => {
    let restored = false;
    for (const entry of ctx.sessionManager.getEntries().reverse()) {
      if (entry.type === "custom" && entry.customType === "role-switcher") {
        activeRole = (entry.data as any)?.role ?? DEFAULT_ROLE;
        restored = true;
        break;
      }
    }
    if (!restored) {
      activeRole = DEFAULT_ROLE;
    }
    ctx.ui.setStatus("role", `role: ${activeRole}`);
  });

  // ── Inject role prompt into system prompt before each turn ──
  pi.on("before_agent_start", async (event, ctx) => {
    const rolePath = ROLES[activeRole];
    if (!rolePath) return;

    const rolePrompt = await readRole(rolePath);
    if (rolePrompt === null) {
      ctx.ui.notify(`Role file not found: ${rolePath}`, "warning");
      return;
    }

    const trimmed = rolePrompt.trim();
    if (!trimmed) return;

    const baseSystem = event.systemPrompt ?? "";
    const newSystem = `${baseSystem}\n\n## Role Override (${activeRole})\n\n${trimmed}`;

    ctx.ui.setStatus("role", `role: ${activeRole}`);
    return { systemPrompt: newSystem };
  });

  // ── /role [<name>] ──
  pi.registerCommand("role", {
    description: "Switch agent role",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      const availableNames = Object.keys(ROLES);

      // With argument — switch directly
      if (requested) {
        if (!ROLES[requested]) {
          ctx.ui.notify(
            `Unknown role "${requested}". Available: ${availableNames.join(", ")}`,
            "error"
          );
          return;
        }
        activeRole = requested;
        pi.appendEntry("role-switcher", { role: activeRole, switchedAt: Date.now() });
        ctx.ui.setStatus("role", `role: ${activeRole}`);
        ctx.ui.notify(`Switched to role: ${activeRole}`, "info");
        return;
      }

      // Without argument — TUI select
      if (!ctx.hasUI) {
        ctx.ui.notify(`Current role: ${activeRole}. Available: ${availableNames.join(", ")}`, "info");
        return;
      }

      const choice = await ctx.ui.select(
        `Select role (current: ${activeRole})`,
        availableNames
      );

      if (!choice || !ROLES[choice]) return;

      activeRole = choice;
      pi.appendEntry("role-switcher", { role: activeRole, switchedAt: Date.now() });
      ctx.ui.setStatus("role", `role: ${activeRole}`);
      ctx.ui.notify(`Switched to role: ${activeRole}`, "info");
    },
  });
}
