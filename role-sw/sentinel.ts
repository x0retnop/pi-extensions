/**
 * SYSTEM.md canary. Pi needs a non-empty customPrompt to skip its default
 * persona. role-sw strips this block when a role loads; if nothing replaces
 * the prompt, the model must see only this alarm.
 *
 * Keep `~/.pi/agent/SYSTEM.md` identical to SENTINEL_ALARM (this file is the
 * in-repo copy). Do not add "ignore if a role is present" — that is why models
 * used to quietly keep working.
 */
export const SENTINEL_MARKER = "ROLE_SW_REQUIRED";

export const SENTINEL_ALARM = [
  SENTINEL_MARKER,
  "RUNTIME BROKEN. role-sw did not inject a role. Reply with exactly one line: РАНТАЙМ СЛОМАН: нет роли. Do no other work.",
].join("\n");

const LEGACY_START = "SENTINEL — this block is NOT your system prompt.";
const LEGACY_END = "└─────────────────────────────────────────┘";

const STRUCTURAL = /^(Current working directory:|Current date:|<project_context\b|## )/;

function leadingWsLen(s: string): number {
  const i = s.search(/\S/);
  return i < 0 ? s.length : i;
}

function stripLegacySentinel(prompt: string): string {
  const idx = prompt.indexOf(LEGACY_START);
  if (idx < 0) return prompt;
  const end = prompt.indexOf(LEGACY_END, idx);
  if (end >= 0) {
    return prompt.slice(0, idx) + prompt.slice(end + LEGACY_END.length);
  }
  const from = prompt.slice(idx);
  const lines = from.split("\n");
  let i = 1;
  for (; i < lines.length; i++) {
    if (STRUCTURAL.test(lines[i])) break;
  }
  return prompt.slice(0, idx) + lines.slice(i).join("\n");
}

function stripCurrentSentinel(prompt: string): string {
  const ws = leadingWsLen(prompt);
  const t = prompt.slice(ws);
  if (t.startsWith(SENTINEL_ALARM)) {
    return t.slice(SENTINEL_ALARM.length);
  }
  if (!t.startsWith(SENTINEL_MARKER)) return prompt;
  const lines = t.split("\n");
  let i = 1;
  for (; i < lines.length; i++) {
    if (STRUCTURAL.test(lines[i])) break;
    if (lines[i].trim() === "" && i + 1 < lines.length && STRUCTURAL.test(lines[i + 1])) {
      i += 1;
      break;
    }
  }
  return lines.slice(i).join("\n");
}

/** Remove the SYSTEM.md canary (current or legacy) from a Pi base prompt. */
export function stripSentinel(prompt: string): string {
  return stripCurrentSentinel(stripLegacySentinel(prompt));
}

/**
 * Interactive system prompt: role first, then AGENTS/cwd/date from the base.
 * Missing/empty role → alarm only (no AGENTS.md for the model to follow).
 */
export function composeInteractivePrompt(
  roleText: string | null | undefined,
  baseSystem: string,
): string {
  const role = (roleText ?? "").trim();
  if (!role) return SENTINEL_ALARM;
  const rest = stripSentinel(baseSystem).trim();
  return rest ? `${role}\n\n${rest}` : role;
}
