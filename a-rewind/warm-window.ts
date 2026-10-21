/**
 * /warm idle-window decision — pure, so it is unit-testable.
 *
 * The idle clock is anchored to the LAST PROVIDER REQUEST, not to `agent_settled`:
 * a prompt-cache entry's TTL starts when the provider receives the request, while
 * `agent_settled` fires only after the final reply has finished streaming. With a
 * long reasoning reply the two can differ by minutes — an anchor at the settle
 * would report "just went idle" for a cache that is already most of the way to
 * expiry, and the keep-alive would land after it expired (a full-price rebuild).
 */

/** Too early: cache still hot; a warm request is pure waste. */
export const WARM_MIN_IDLE_MS = 3 * 60 * 1000;
/**
 * Too late for a cheap warm (Kimi's ~5m cache TTL).
 * Past this, a keep-alive request is likely a full prefix rebuild.
 * Tunable — Kimi often lives longer; this is the safe "don't gamble" cut.
 */
export const WARM_MAX_IDLE_MS = (4 * 60 + 45) * 1000;

export type WarmWindowCode = "busy" | "no_activity" | "too_early" | "too_late" | "ok";

export interface WarmWindow {
	ok: boolean;
	code: WarmWindowCode;
	/** ms until the window opens (code `too_early`). */
	waitMs?: number;
	/** ms left before the window closes (code `ok`). */
	leftMs?: number;
}

/** Decide whether an idle gap is inside the warm window. `busy` short-circuits. */
export function warmWindow(
	idleMs: number | undefined,
	busy: boolean,
	bounds: { minMs?: number; maxMs?: number } = {},
): WarmWindow {
	const minMs = bounds.minMs ?? WARM_MIN_IDLE_MS;
	const maxMs = bounds.maxMs ?? WARM_MAX_IDLE_MS;
	if (busy) return { ok: false, code: "busy" };
	if (idleMs === undefined) return { ok: false, code: "no_activity" };
	if (idleMs < minMs) return { ok: false, code: "too_early", waitMs: minMs - idleMs };
	if (idleMs > maxMs) return { ok: false, code: "too_late" };
	return { ok: true, code: "ok", leftMs: maxMs - idleMs };
}
