import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_INJECT_TYPE = "project-agents";
export const AGENTS_FILENAME = "AGENTS.md";

export function normalizeAgentsPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function formatAgentsInjectMessage(absPath: string, content: string): string {
  const path = normalizeAgentsPath(absPath);
  return `Follow this project guide. Full file already below. Disk only if editing: ${path}\n\n${content}`;
}

export function resolveCwdAgentsPath(cwd: string): string {
  return join(cwd, AGENTS_FILENAME);
}

export function readCwdAgentsFile(cwd: string): { path: string; content: string } | null {
  const filePath = resolveCwdAgentsPath(cwd);
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    if (!content) return null;
    return { path: filePath, content };
  } catch {
    return null;
  }
}

export function shouldInjectAgents(opts: {
  isChild: boolean;
  enabled: boolean;
  entries: ReadonlyArray<{ type?: string; customType?: string; message?: { role?: string } }>;
}): boolean {
  if (opts.isChild || !opts.enabled) return false;
  for (const e of opts.entries) {
    if (e?.customType === AGENTS_INJECT_TYPE) return false;
    const role = e?.message?.role;
    if (e?.type === "message" && (role === "user" || role === "assistant")) return false;
  }
  return true;
}

export function injectAgentsIfNeeded(
  pi: {
    sendMessage: (
      message: { customType: string; content: string; display: boolean },
    ) => void;
  },
  ctx: { cwd: string; sessionManager?: { getEntries?: () => unknown[] } },
  enabled: boolean,
): boolean {
  const entries = (ctx.sessionManager?.getEntries?.() ?? []) as Array<{
    type?: string;
    customType?: string;
    message?: { role?: string };
  }>;
  if (
    !shouldInjectAgents({
      isChild: process.env.PI_SUB_AGENTS_CHILD === "1",
      enabled,
      entries,
    })
  ) {
    return false;
  }
  const file = readCwdAgentsFile(ctx.cwd);
  if (!file) return false;
  pi.sendMessage({
    customType: AGENTS_INJECT_TYPE,
    content: formatAgentsInjectMessage(file.path, file.content),
    display: false,
  });
  return true;
}
