import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setStatusBlock } from "../common/status.js";

// Resolve roles/ directory relative to this extension's index.ts.
// Works for both direct file loading and directory-based extension loading.
function getRolesDir(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return join(dirname(modulePath), "roles");
}

const ROLES_DIR = getRolesDir();
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
      .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function resolveRolePath(name: string): string {
  return join(ROLES_DIR, `${name}.md`);
}

function resolveIncludePath(name: string): string {
  return join(ROLES_DIR, name);
}

async function readFileCached(path: string): Promise<string | null> {
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

const INCLUDE_RE = /^\{\{include:\s*(.+?)\s*\}\}\s*$/gm;

async function resolveIncludes(text: string, visited = new Set<string>()): Promise<string> {
  const matches = [...text.matchAll(INCLUDE_RE)];
  if (matches.length === 0) return text;

  let result = text;
  for (const m of matches) {
    const includeName = m[1];
    const includePath = resolveIncludePath(includeName);

    if (visited.has(includePath)) {
      result = result.replace(m[0], `<!-- circular include skipped: ${includeName} -->\n`);
      continue;
    }

    const inc = await readFileCached(includePath);
    if (inc === null) {
      result = result.replace(m[0], `<!-- missing include: ${includeName} -->\n`);
      continue;
    }

    const nested = await resolveIncludes(inc, new Set([...visited, includePath]));
    result = result.replace(m[0], nested.trimEnd() + "\n");
  }

  return result;
}

async function readRole(path: string): Promise<string | null> {
  const raw = await readFileCached(path);
  if (raw === null) return null;
  return resolveIncludes(raw);
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

    setStatusBlock(ctx, "role", `role:${activeRole}`);
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

    setStatusBlock(ctx, "role", `role:${activeRole}`);
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
        setStatusBlock(ctx, "role", `role:${activeRole}`);
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
      setStatusBlock(ctx, "role", `role:${activeRole}`);
      ctx.ui.notify(`Switched to role: ${activeRole}`, "info");
    },
  });
}
