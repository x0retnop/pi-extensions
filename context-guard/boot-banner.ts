import { MANAGED_FEATURES, shortLabel } from "./features.js";
import type { GuardSettings } from "./types.js";
import { DEFAULT_CONTEXT_NOTICES } from "./types.js";
import { getContextNoticesFired } from "./context-notices.js";
import {
  type SurfaceChrome,
  BOOT_DEFAULTS,
  renderRibbon,
  toSurfaceChrome,
} from "../common/chrome.js";

function mark(on: boolean): string {
  return on ? "✓" : "✗";
}

export function buildStatusText(settings: GuardSettings): string {
  const lines: string[] = [];
  lines.push("=== Context Guard ===\n");

  lines.push("Prompt in context");
  for (const f of MANAGED_FEATURES.filter((f) => f.category === "prompt")) {
    const enabled = settings.promptRules[f.id] ?? f.defaultEnabled;
    lines.push(`  ${mark(enabled)}  ${f.label}`);
  }

  lines.push("\nTools");
  for (const f of MANAGED_FEATURES.filter((f) => f.category === "tools")) {
    const enabled = settings.features[f.id] ?? f.defaultEnabled;
    lines.push(`  ${mark(enabled)}  ${f.label}`);
  }

  lines.push("\nSkills");
  lines.push(`  ${mark(settings.autoSkills !== false)}  Auto-inject skill list`);
  lines.push(`  ${mark(settings.agentsInject !== false)}  Inject AGENTS.md as first message`);

  const cn = settings.contextNotices ?? DEFAULT_CONTEXT_NOTICES;
  const fired = getContextNoticesFired();
  lines.push("\nNotices (context pressure)");
  lines.push(`  ${mark(cn.enabled)}  Master switch`);
  lines.push(`  ${mark(cn.notice60)}  At 60% context${fired.notice60 ? " · fired" : ""}`);
  lines.push(`  ${mark(cn.notice70)}  At 70% context${fired.notice70 ? " · fired" : ""}`);

  lines.push("\nCommands:");
  lines.push("  /context-guard         interactive TUI");
  lines.push("  /context-guard <id>    toggle (date, cwd, agents, agentsInject, bash, …)");
  lines.push("  /context-guard reset   restore defaults");
  lines.push("  /context               context overview");
  lines.push("  /use-skill <name>      inject a skill manually");

  return lines.join("\n");
}

export interface BootBannerInfo {
  cwd?: string;
  /** Active role-sw role name, if any. */
  role?: string | null;
  /** session_start reason: startup | reload | new | resume | fork */
  reason?: string;
}

/**
 * Compact boot ribbon as string lines for the session-start splash.
 * Enabled features only (OFF items omitted). Skin from `uiTheme.boot`
 * (frame / rails / itemLead / catMark / …); runtime frames `none`.
 * Rendered as transient chat text (notify), not a pinned widget.
 * Pass `chrome` from the caller — do not read settings.json here (tests).
 */
export function buildBootBannerLines(
  settings: GuardSettings,
  _info: BootBannerInfo = {},
  chrome: SurfaceChrome = toSurfaceChrome(BOOT_DEFAULTS),
): string[] {
  const promptItems: string[] = [];
  for (const f of MANAGED_FEATURES.filter((x) => x.category === "prompt")) {
    if (settings.promptRules[f.id] ?? f.defaultEnabled) promptItems.push(shortLabel(f.id));
  }
  if (settings.agentsInject !== false) promptItems.push(shortLabel("agentsInject"));

  const toolItems: string[] = [];
  for (const f of MANAGED_FEATURES.filter((x) => x.category === "tools")) {
    if (settings.features[f.id] ?? f.defaultEnabled) toolItems.push(shortLabel(f.id));
  }
  if (settings.autoSkills !== false) toolItems.push(shortLabel("autoSkills"));

  const cn = { ...DEFAULT_CONTEXT_NOTICES, ...(settings.contextNotices ?? {}) };
  const noticeItems: string[] = [];
  if (cn.enabled) {
    if (cn.notice60) noticeItems.push("60");
    if (cn.notice70) noticeItems.push("70");
    if (noticeItems.length === 0) noticeItems.push("on");
  }

  return renderRibbon(
    [
      { label: "prompt", items: promptItems },
      { label: "tools", items: toolItems },
      { label: "notices", items: noticeItems },
    ],
    chrome,
  );
}

/** Multiline string form (tests / plain-text fallbacks). */
export function buildBootBanner(
  settings: GuardSettings,
  info: BootBannerInfo = {},
  chrome?: SurfaceChrome,
): string {
  return buildBootBannerLines(settings, info, chrome).join("\n");
}
