import { readFileCached, resolveIncludePath } from "../role-sw/roles.js";

/** Role placeholder. Replaced with `_Sub-agents.md` when `/sub` is on; stripped when off. */
export const PARENT_SECTION_FILE = "_Sub-agents.md";

function markerRe(): RegExp {
  return /[ \t]*<!--\s*sub-agents\s*-->[ \t]*/g;
}

export function containsSubAgentsMarker(text: string): boolean {
  return markerRe().test(text);
}

/**
 * `/new` with no saved state → OFF and persist.
 * Existing state wins. No state on resume/startup/reload/fork → legacy ON.
 */
export function resolveSubAgentsEnabled(
  state: { enabled: boolean } | null,
  reason?: string,
): { enabled: boolean; persistDefault: boolean } {
  if (state) return { enabled: state.enabled, persistDefault: false };
  if (reason === "new") return { enabled: false, persistDefault: true };
  return { enabled: true, persistDefault: false };
}

export function applySubAgentsSection(
  systemPrompt: string,
  enabled: boolean,
  section: string | null,
): string {
  if (!containsSubAgentsMarker(systemPrompt)) return systemPrompt;
  const body = enabled ? section?.trim() ?? "" : "";
  const next = systemPrompt.replace(markerRe(), body);
  return body ? next : next.replace(/\n{3,}/g, "\n\n");
}

export async function loadParentSection(dir?: string): Promise<string | null> {
  return readFileCached(resolveIncludePath(PARENT_SECTION_FILE, dir));
}
