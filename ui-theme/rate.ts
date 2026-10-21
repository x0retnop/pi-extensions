/**
 * Tok/s rate bar → setStatus("zz-rate").
 * Custom footer paints it on the usage line and strips it from statuses.
 * Built-in footer still shows it as a status block.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { setStatusBlock } from "../common/status.js";
import { barParts } from "./paint.js";
import { DEFAULTS, type UiThemeSettings } from "./settings.js";

export const RATE_STATUS_KEY = "zz-rate";
const STATUS_KEY = RATE_STATUS_KEY;
const TICK_MS = 250;
const MIN_LIVE_MS = 800;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const RATE_WIDTH = 4;
const RATE_PLACEHOLDER = "·";
const RATE_BAR_LEN = 8;

const ANSI_CYAN = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

interface RateSession {
  startTime: number;
  units: number;
}

let currentCtx: ExtensionContext | null = null;
let session: RateSession | null = null;
let lastRate: number | null = null;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let getSettings: () => UiThemeSettings = () => ({ ...DEFAULTS });

export function setRateDeps(opts: { getSettings: () => UiThemeSettings }): void {
  getSettings = opts.getSettings;
}

export function setRateCtx(ctx: ExtensionContext | null): void {
  currentCtx = ctx;
}

function deltaChars(event: AssistantMessageEvent): number {
  if (
    (event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta") &&
    typeof event.delta === "string"
  ) {
    return event.delta.length;
  }
  return 0;
}

function startRateSession(): void {
  session = { startTime: Date.now(), units: 0 };
}

function liveRate(): number | null {
  if (!session) return null;
  const elapsed = (Date.now() - session.startTime) / 1000;
  if (elapsed < MIN_LIVE_MS / 1000) return null;
  if (session.units <= 0) return null;
  return session.units / elapsed;
}

export interface RateParts {
  bar: string;
  num: string;
  full: string;
}

let lastParts: RateParts = { bar: "", num: "", full: "" };

export function getRateParts(): RateParts {
  if (!lastParts.bar) fmtRateBar(lastRate, getSettings().maxTps);
  return lastParts;
}

function fmtRateBar(r: number | null, maxTps: number, barStyle = getSettings().barStyle): string {
  const frac = r !== null && r > 0 ? Math.min(r / maxTps, 1) : 0;
  const { hot, cold } = barParts(frac, RATE_BAR_LEN, barStyle);
  const glyphs = ANSI_CYAN + hot + ANSI_RESET + ANSI_DIM + cold + ANSI_RESET;
  const bar = `▸ ${glyphs}`;
  const num =
    r !== null
      ? String(Math.round(r)).padEnd(RATE_WIDTH, RATE_PLACEHOLDER)
      : RATE_PLACEHOLDER.repeat(RATE_WIDTH);
  lastParts = { bar, num, full: `${bar} ${num}` };
  return lastParts.full;
}

function renderStatus(): string | undefined {
  const s = getSettings();
  if (!s.rate) return undefined;
  const live = liveRate();
  if (live !== null && live > 0) return fmtRateBar(live, s.maxTps);
  if (lastRate !== null && lastRate > 0) return fmtRateBar(lastRate, s.maxTps);
  return fmtRateBar(null, s.maxTps);
}

export function updateRateStatus(): void {
  setStatusBlock(currentCtx, STATUS_KEY, renderStatus());
}

export function clearRateStatus(): void {
  setStatusBlock(currentCtx, STATUS_KEY, undefined);
}

export function startRateTick(): void {
  if (tickTimer !== undefined) return;
  tickTimer = setInterval(() => {
    if (session) updateRateStatus();
  }, TICK_MS);
}

export function stopRateTick(): void {
  if (tickTimer !== undefined) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
}

export function resetRateState(): void {
  session = null;
  lastRate = null;
}

export function onRateMessageStart(ctx: ExtensionContext): void {
  if (!getSettings().rate) return;
  currentCtx = ctx;
  startRateSession();
  updateRateStatus();
}

export function onRateMessageUpdate(event: { assistantMessageEvent: AssistantMessageEvent; message: any }): void {
  if (!getSettings().rate) return;
  if (!session) return;

  const delta = deltaChars(event.assistantMessageEvent);
  if (delta > 0) {
    session.units += delta / CHARS_PER_TOKEN_ESTIMATE;
    updateRateStatus();
    return;
  }

  const msg = event.message as any;
  if (msg.role !== "assistant") return;

  const out = msg.usage?.output ?? 0;
  if (out > 0) {
    session.units = out;
    updateRateStatus();
    return;
  }

  let chars = 0;
  for (const b of msg.content ?? []) {
    if (b?.type === "text" && typeof b.text === "string") chars += b.text.length;
    if (b?.type === "thinking" && typeof b.thinking === "string") chars += b.thinking.length;
    if (b?.type === "toolCall") {
      if (typeof b.partialJson === "string") chars += b.partialJson.length;
      else if (b.arguments && typeof b.arguments === "object") {
        try {
          chars += JSON.stringify(b.arguments).length;
        } catch {
          // ignore
        }
      }
    }
  }
  session.units = chars / CHARS_PER_TOKEN_ESTIMATE;
  updateRateStatus();
}

export function onRateMessageEnd(): void {
  if (!getSettings().rate) return;
  const live = liveRate();
  if (live !== null && live > 0) {
    lastRate = live;
  } else if (session && session.units > 0) {
    const elapsed = Math.max((Date.now() - session.startTime) / 1000, MIN_LIVE_MS / 1000);
    lastRate = session.units / elapsed;
  }
  session = null;
  updateRateStatus();
}

export function applyRateFromSettings(): void {
  if (!getSettings().rate) {
    clearRateStatus();
    return;
  }
  updateRateStatus();
}
