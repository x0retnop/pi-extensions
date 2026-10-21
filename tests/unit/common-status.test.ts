import assert from "node:assert";
import { describe, it } from "node:test";

import {
  formatDurationHMS,
  formatTimerStatus,
  setStatusBlock,
} from "../../common/status.js";

describe("common formatDurationHMS", () => {
  // Under one hour: minutes are unpadded, seconds are zero-padded (m:ss / mm:ss via pad only on ss).
  it("formats under one hour as m:ss with zero-padded seconds", () => {
    assert.strictEqual(formatDurationHMS(0), "0:00");
    assert.strictEqual(formatDurationHMS(5_000), "0:05");
    assert.strictEqual(formatDurationHMS(65_000), "1:05");
    assert.strictEqual(formatDurationHMS(3_599_000), "59:59");
  });

  it("formats hours as h:mm:ss", () => {
    assert.strictEqual(formatDurationHMS(3_600_000), "1:00:00");
    assert.strictEqual(formatDurationHMS(3_661_000), "1:01:01");
  });

  it("clamps negative to zero", () => {
    assert.strictEqual(formatDurationHMS(-100), "0:00");
  });
});

describe("common formatTimerStatus", () => {
  it("shows total only", () => {
    assert.strictEqual(formatTimerStatus({ totalMs: 5_000 }), "0:05");
  });

  it("shows total · last", () => {
    assert.strictEqual(
      formatTimerStatus({ totalMs: 65_000, lastMs: 5_000 }),
      "1:05 · 0:05",
    );
  });

  it("appends tool call counts when provided", () => {
    assert.strictEqual(
      formatTimerStatus({ totalMs: 5_000, lastMs: 1_000, totalCalls: 12, lastCalls: 3 }),
      "0:05 · 0:01 | 12 · 3",
    );
  });
});

describe("common setStatusBlock", () => {
  it("no-ops without UI", () => {
    setStatusBlock({ hasUI: false }, "k", "v");
    setStatusBlock({}, "k", "v");
  });

  it("appends separator to visible values and passes undefined through", () => {
    const calls: Array<[string, string | undefined]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: (key: string, text: string | undefined) => {
          calls.push([key, text]);
        },
      },
    };
    setStatusBlock(ctx, "web-access", "web:on");
    setStatusBlock(ctx, "web-access", undefined);
    setStatusBlock(ctx, "web-access", "");
    assert.deepStrictEqual(calls, [
      ["web-access", "web:on |"],
      ["web-access", undefined],
      ["web-access", undefined],
    ]);
  });

  it("swallows setStatus errors", () => {
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: () => {
          throw new Error("boom");
        },
      },
    };
    assert.doesNotThrow(() => setStatusBlock(ctx, "x", "y"));
  });
});
