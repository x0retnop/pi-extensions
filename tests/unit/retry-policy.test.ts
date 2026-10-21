import assert from "node:assert";
import { describe, it } from "node:test";

import {
  AUTO_CONTINUE_DELAYS_MS,
  RESPAWN_DELAYS_MS,
  RETRY_LADDER_MS,
  delayForAttempt,
  isHardStopError,
  isPayloadRejectionError,
} from "../../common/retry-policy.js";

describe("retry-policy hard stop", () => {
  it("retries unknown and transient wording", () => {
    const transient = [
      // Real errors from the last 30 days of session logs.
      '429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
      '429 {"error":{"type":"rate_limit_error","message":"The engine is currently overloaded, please try again later"}}',
      "Connection error.",
      "This operation was aborted",
      "Request timed out.",
      "terminated",
      "Stream ended without finish_reason",
      "Error Code null: The model is currently at capacity due to high demand.",
      "500 Unknown Error",
      '500: {"code":500,"message":"While executing CallExpression"}',
      "502 Bad Gateway",
      '429: {"code":"backend_busy","type":"rate_limit_error","message":"backend busy"}',
      "Streaming response failed: [router_error] model upstream is unavailable",
      // Unseen wording: the whole point of the inversion.
      '{"error":{"message":"no healthy upstream for this model right now"}}',
      "",
    ];
    for (const text of transient) {
      assert.strictEqual(isHardStopError(text), false, `should retry: ${text}`);
    }
  });

  it("stops on deterministic failures only", () => {
    const hard = [
      "GoUsageLimitError",
      "FreeUsageLimitError",
      "insufficient_quota",
      "Monthly usage limit reached",
      '403 {"error":{"type":"permission_error","message":"You have reached your weekly (7-day) usage limit. Your quota will reset"}}',
      "xai API error (403): You have run out of credits or need a Grok subscription.",
      '403: {"type":"server_error","message":"Upstream request failed: An active OpenCode Go subscription is required"}',
      "401: {\"type\":\"authentication_error\",\"message\":\"This API key has expired\"}",
      "invalid api key",
      "400: unsupported parameter",
      '404: {"message":"model not found"}',
      "maximum context length is 128000 tokens",
      "This text request is too large for the model",
    ];
    for (const text of hard) {
      assert.strictEqual(isHardStopError(text), true, `should stop: ${text}`);
    }
  });

  it("a routing 403 is not an auth 403", () => {
    assert.strictEqual(isHardStopError('403: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}'), false);
    assert.strictEqual(isHardStopError("403 forbidden"), true);
  });

  it("payload rejections are the subset a fresh run can fix", () => {
    assert.strictEqual(isPayloadRejectionError("400: tool_use ids were found without tool_result blocks"), true);
    assert.strictEqual(isPayloadRejectionError("Connection error."), false);
    assert.strictEqual(isPayloadRejectionError("GoUsageLimitError"), false);
    assert.strictEqual(isPayloadRejectionError("401 unauthorized"), false);
  });
});

describe("retry-policy ladders", () => {
  it("the ladder is shared and monotonic", () => {
    assert.deepStrictEqual([...RETRY_LADDER_MS], [2_000, 4_000, 8_000, 30_000, 60_000, 120_000]);
    for (const ladder of [RETRY_LADDER_MS, RESPAWN_DELAYS_MS, AUTO_CONTINUE_DELAYS_MS]) {
      for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] > ladder[i - 1]);
    }
  });

  it("delayForAttempt is 1-indexed and clamps to the last rung", () => {
    assert.strictEqual(delayForAttempt(RETRY_LADDER_MS, 1), 2_000);
    assert.strictEqual(delayForAttempt(RETRY_LADDER_MS, 4), 30_000);
    assert.strictEqual(delayForAttempt(RETRY_LADDER_MS, 6), 120_000);
    assert.strictEqual(delayForAttempt(RETRY_LADDER_MS, 99), 120_000);
    assert.strictEqual(delayForAttempt(RETRY_LADDER_MS, 0), 2_000);
    assert.strictEqual(delayForAttempt([], 3), 0);
  });

  it("the outer layers are the slow tail, not a repeat of Pi's fast retries", () => {
    const fast = RETRY_LADDER_MS.slice(0, 3);
    for (const ms of [...RESPAWN_DELAYS_MS, ...AUTO_CONTINUE_DELAYS_MS]) {
      assert.ok(!fast.includes(ms as 2_000 | 4_000 | 8_000), `${ms} duplicates a fast rung`);
    }
  });
});
