/**
 * Provider-error policy shared by every layer we own: the sub-agent respawn loop
 * (`sub-agents/runner.ts`) and `a-rewind`'s auto-continue.
 *
 * Pi's own in-run retry fires first and is configured by `settings.retry`
 * (exponential `baseDelayMs * 2^(n-1)` capped by `maxAgentDelayMs` — the runtime
 * offers no way to supply an arbitrary ladder). These constants are the layers
 * *after* it, so they are the slow tail: by the time a turn reaches us, Pi has
 * already burned its fast attempts.
 *
 * Inversion is deliberate: an error stops the turn only when it is in
 * HARD_STOP — deterministic failures that the same request cannot fix. Anything
 * unrecognised is retried, because providers invent transient wordings faster
 * than any list can track, and a missed retry costs the whole turn (or a whole
 * delegated task), while a wasted attempt costs seconds.
 */

/** Canonical ladder, in one place. Retune here, not per caller. */
export const RETRY_LADDER_MS = [2_000, 4_000, 8_000, 30_000, 60_000, 120_000] as const;

/** Sub-agent respawn: the tail of the ladder (Pi retried fast inside the child). */
export const RESPAWN_DELAYS_MS = [60_000, 120_000] as const;

/** Auto-continue after Pi gave up: one rung earlier, three attempts. */
export const AUTO_CONTINUE_DELAYS_MS = [30_000, 60_000, 120_000] as const;

/**
 * Deterministic failures only — a retry re-sends the same request and would
 * earn the identical answer.
 *
 * Deliberately absent: bare `403`/`429`/`5xx` and any routing wording
 * (`upstream`, `unavailable`, `server_error`, `backend_busy`, `overloaded`).
 * A 403 from OpenCode Go carries either "subscription required" (hard, matched
 * below) or "Upstream request failed" (transient, must retry), so the status
 * code alone decides nothing.
 */
const HARD_STOP_PATTERN = new RegExp(
  [
    // Money and subscription quota: waiting never refills them.
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "insufficient_quota",
    "quota exceeded",
    "quota will reset",
    "out of budget",
    "out of credits",
    "\\bbilling\\b",
    "Monthly usage limit",
    "available balance",
    "usage limit",
    "subscription is required",
    "subscription_sharing_usage_limit_exceeded",
    "subscription_sharing_usage_unavailable",
    // Auth: the key is wrong, expired, or lacks the scope.
    "\\b401\\b",
    "api_key_expired",
    "invalid.?api.?key",
    "unauthorized",
    "authentication_error",
    "no api key",
    "permission_error",
    "\\bforbidden\\b",
    // The request itself is invalid: same payload, same rejection.
    "\\b400\\b",
    "invalid_request_error",
    "unsupported_request",
    "model_not_found",
    "\\b404\\b",
    // Context overflow: compaction owns this, not a retry.
    "context (length|window) exceeded",
    "maximum context length",
    "maximum prompt length",
    "prompt is too long",
    "prompt too long",
    "too many tokens",
    "request too large",
    "text request is too large",
    "exceeds the (model's )?context",
    "exceeded model token limit",
  ].join("|"),
  "i",
);

/** True when the turn must stop: the error is deterministic, not transient. */
export function isHardStopError(text: string | undefined | null): boolean {
  if (!text) return false;
  return HARD_STOP_PATTERN.test(text);
}

/**
 * The slice of the hard-stop list that a *fresh* run can fix but a resumed one
 * cannot: the conversation itself is the problem (a dangling tool call from a
 * stream that died mid-call earns a 400; an over-long history earns an
 * overflow). Used once per sub-agent run as a safety valve — never for
 * quota/auth, where a fresh attempt would only burn a spawn.
 */
const PAYLOAD_REJECTION_PATTERN = new RegExp(
  [
    "\\b400\\b",
    "invalid_request_error",
    "unsupported_request",
    "tool_use",
    "tool_result",
    "context (length|window) exceeded",
    "maximum context length",
    "maximum prompt length",
    "prompt is too long",
    "prompt too long",
    "too many tokens",
    "request too large",
    "text request is too large",
    "exceeds the (model's )?context",
    "exceeded model token limit",
  ].join("|"),
  "i",
);

export function isPayloadRejectionError(text: string | undefined | null): boolean {
  if (!text) return false;
  return PAYLOAD_REJECTION_PATTERN.test(text);
}

/** Delay before attempt `attempt` (1-indexed) of the given ladder. */
export function delayForAttempt(ladder: readonly number[], attempt: number): number {
  if (ladder.length === 0) return 0;
  const index = Math.min(Math.max(attempt, 1) - 1, ladder.length - 1);
  return ladder[index] ?? 0;
}
