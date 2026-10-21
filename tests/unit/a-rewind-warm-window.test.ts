import assert from "node:assert";
import { describe, it } from "node:test";

import {
	WARM_MAX_IDLE_MS,
	WARM_MIN_IDLE_MS,
	warmWindow,
} from "../../a-rewind/warm-window.js";

describe("warmWindow — gating", () => {
	it("busy short-circuits regardless of idle", () => {
		assert.deepStrictEqual(warmWindow(60_000, true), { ok: false, code: "busy" });
		assert.deepStrictEqual(warmWindow(undefined, true), { ok: false, code: "busy" });
	});

	it("no prior request → no_activity", () => {
		assert.deepStrictEqual(warmWindow(undefined, false), { ok: false, code: "no_activity" });
	});
});

describe("warmWindow — window bounds", () => {
	it("below the minimum → too_early with the remaining wait", () => {
		const w = warmWindow(WARM_MIN_IDLE_MS - 30_000, false);
		assert.strictEqual(w.ok, false);
		assert.strictEqual(w.code, "too_early");
		assert.strictEqual(w.waitMs, 30_000);
	});

	it("exactly at the minimum → open", () => {
		const w = warmWindow(WARM_MIN_IDLE_MS, false);
		assert.strictEqual(w.ok, true);
		assert.strictEqual(w.code, "ok");
		assert.strictEqual(w.leftMs, WARM_MAX_IDLE_MS - WARM_MIN_IDLE_MS);
	});

	it("inside the window → open with the time left before the cut", () => {
		const w = warmWindow(WARM_MAX_IDLE_MS - 10_000, false);
		assert.strictEqual(w.ok, true);
		assert.strictEqual(w.leftMs, 10_000);
	});

	it("exactly at the maximum → still open (inclusive)", () => {
		assert.strictEqual(warmWindow(WARM_MAX_IDLE_MS, false).ok, true);
	});

	it("past the maximum → too_late", () => {
		const w = warmWindow(WARM_MAX_IDLE_MS + 1, false);
		assert.strictEqual(w.ok, false);
		assert.strictEqual(w.code, "too_late");
	});
});

describe("warmWindow — custom bounds", () => {
	it("honours caller-supplied min/max", () => {
		assert.strictEqual(warmWindow(500, false, { minMs: 1_000, maxMs: 10_000 }).code, "too_early");
		assert.strictEqual(warmWindow(5_000, false, { minMs: 1_000, maxMs: 10_000 }).ok, true);
		assert.strictEqual(warmWindow(20_000, false, { minMs: 1_000, maxMs: 10_000 }).code, "too_late");
	});
});
