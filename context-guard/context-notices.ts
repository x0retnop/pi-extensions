/**
 * One-shot context pressure notices at 60% / 70% fill.
 * Injects user-shaped custom messages via the `context` event (once per threshold per session).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextNoticesSettings } from "./types.js";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

export const NOTICE_60_THRESHOLD = 60;
export const NOTICE_70_THRESHOLD = 70;

const PROMPT_FILES = {
  60: "notice-60.md",
  70: "notice-70.md",
} as const;

export type NoticeThreshold = 60 | 70;

export interface ContextNoticesFired {
  notice60: boolean;
  notice70: boolean;
}

const fired: ContextNoticesFired = {
  notice60: false,
  notice70: false,
};

const promptCache = new Map<NoticeThreshold, string | null>();

export function resetContextNoticesFired(): void {
  fired.notice60 = false;
  fired.notice70 = false;
}

export function getContextNoticesFired(): ContextNoticesFired {
  return { ...fired };
}

export function clearContextNoticesFired(): void {
  resetContextNoticesFired();
}

function loadPrompt(threshold: NoticeThreshold): string | null {
  if (promptCache.has(threshold)) {
    return promptCache.get(threshold) ?? null;
  }
  const file = join(EXT_DIR, PROMPT_FILES[threshold]);
  try {
    if (!existsSync(file)) {
      promptCache.set(threshold, null);
      return null;
    }
    // Strip HTML comments so editors can leave notes without sending them to the model.
    const text = readFileSync(file, "utf-8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    const value = text.length > 0 ? text : null;
    promptCache.set(threshold, value);
    return value;
  } catch {
    promptCache.set(threshold, null);
    return null;
  }
}

/** Drop cached prompt text (e.g. after editing md files mid-session). */
export function reloadContextNoticePrompts(): void {
  promptCache.clear();
}

function buildNoticeMessage(threshold: NoticeThreshold, body: string, percent: number) {
  return {
    role: "custom" as const,
    customType: `context-notice-${threshold}`,
    content: body,
    display: false,
    details: { threshold, percent: Math.round(percent * 10) / 10 },
    timestamp: Date.now(),
  };
}

/**
 * Apply pending notices to the message list for the next LLM call.
 * Returns messages unchanged when master is off or nothing is due.
 */
export function applyContextNotices(
  messages: any[],
  settings: ContextNoticesSettings,
  ctx: ExtensionContext,
): any[] | undefined {
  if (!settings.enabled) return undefined;

  const usage = ctx.getContextUsage?.();
  const percent = usage?.percent;
  if (percent == null || !Number.isFinite(percent)) return undefined;

  const toFire: NoticeThreshold[] = [];
  if (settings.notice60 && !fired.notice60 && percent >= NOTICE_60_THRESHOLD) {
    toFire.push(60);
  }
  if (settings.notice70 && !fired.notice70 && percent >= NOTICE_70_THRESHOLD) {
    toFire.push(70);
  }
  if (toFire.length === 0) return undefined;

  const next = [...messages];
  const firedNow: NoticeThreshold[] = [];

  for (const threshold of toFire) {
    const body = loadPrompt(threshold);
    if (!body) continue;
    next.push(buildNoticeMessage(threshold, body, percent));
    if (threshold === 60) fired.notice60 = true;
    if (threshold === 70) fired.notice70 = true;
    firedNow.push(threshold);
  }

  if (firedNow.length === 0) return undefined;

  if (ctx.hasUI) {
    const labels = firedNow.map((t) => `${t}%`).join(", ");
    ctx.ui.notify(`[context-guard] Context notice fired: ${labels} (~${percent.toFixed(1)}%)`, "info");
  }

  return next;
}

export function registerContextNotices(pi: ExtensionAPI, getSettings: () => ContextNoticesSettings): void {
  pi.on("session_start", () => {
    resetContextNoticesFired();
    reloadContextNoticePrompts();
  });

  pi.on("context", (event, ctx) => {
    const updated = applyContextNotices(event.messages, getSettings(), ctx);
    if (updated) return { messages: updated };
    return undefined;
  });
}
