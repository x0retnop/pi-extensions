import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROLES_DIR = join(homedir(), ".pi", "agent", "roles");
const DEFAULT_ROLE = "kimi";

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

async function getAvailableRoles(): Promise<string[]> {
  try {
    const files = await readdir(ROLES_DIR);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function resolveRolePath(name: string): string {
  return join(ROLES_DIR, `${name}.md`);
}

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

    // If the restored role file no longer exists, fall back
    const available = await getAvailableRoles();
    if (!available.includes(activeRole)) {
      activeRole = available.includes(DEFAULT_ROLE) ? DEFAULT_ROLE : (available[0] ?? DEFAULT_ROLE);
    }

    ctx.ui.setStatus("role", `role: ${activeRole}`);
  });

  // ── Inject role prompt into system prompt before each turn ──
  pi.on("before_agent_start", async (event, ctx) => {
    const rolePath = resolveRolePath(activeRole);
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
      const available = await getAvailableRoles();
      if (available.length === 0) {
        ctx.ui.notify(`No role files found in ${ROLES_DIR}`, "error");
        return;
      }

      const requested = args.trim().toLowerCase().replace(/\.md$/, "");

      // With argument — switch directly
      if (requested) {
        if (!available.includes(requested)) {
          ctx.ui.notify(
            `Unknown role "${requested}". Available: ${available.join(", ")}`,
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
        ctx.ui.notify(`Current role: ${activeRole}. Available: ${available.join(", ")}`, "info");
        return;
      }

      const choice = await ctx.ui.select(
        `Select role (current: ${activeRole})`,
        available
      );

      if (!choice || !available.includes(choice)) return;

      activeRole = choice;
      pi.appendEntry("role-switcher", { role: activeRole, switchedAt: Date.now() });
      ctx.ui.setStatus("role", `role: ${activeRole}`);
      ctx.ui.notify(`Switched to role: ${activeRole}`, "info");
    },
  });
}
