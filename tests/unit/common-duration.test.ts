import assert from "node:assert";
import { describe, it } from "node:test";

import { formatDuration, parseDuration } from "../../common/duration.js";

describe("common formatDuration", () => {
  it("keeps sub-second resolution but drops trailing zero units", () => {
    assert.strictEqual(formatDuration(0), "0s");
    assert.strictEqual(formatDuration(1), "0s");
    assert.strictEqual(formatDuration(500), "0.5s");
    assert.strictEqual(formatDuration(1500), "1s");
    assert.strictEqual(formatDuration(45_000), "45s");
  });

  it("pads lower units so a ticking timer keeps its width", () => {
    assert.strictEqual(formatDuration(65_000), "1m 05s");
    assert.strictEqual(formatDuration(723_000), "12m 03s");
    assert.strictEqual(formatDuration(3_661_000), "1h 01m 01s");
  });

  it("drops empty lower units (the timeout case: 300 s -> 5m)", () => {
    assert.strictEqual(formatDuration(120_000), "2m");
    assert.strictEqual(formatDuration(300_000), "5m");
    assert.strictEqual(formatDuration(3_600_000), "1h 00m");
    assert.strictEqual(formatDuration(5_400_000), "1h 30m");
  });

  it("does not render NaN or negative input", () => {
    assert.strictEqual(formatDuration(Number.NaN), "0s");
    assert.strictEqual(formatDuration(-5000), "0s");
  });
});

describe("common parseDuration", () => {
  it("reads a bare number as ms", () => {
    assert.strictEqual(parseDuration("60000"), 60_000);
    assert.strictEqual(parseDuration(" 500 "), 500);
  });

  it("reads human units, spaced or not", () => {
    assert.strictEqual(parseDuration("10m"), 600_000);
    assert.strictEqual(parseDuration("90s"), 90_000);
    assert.strictEqual(parseDuration("1h30m"), 5_400_000);
    assert.strictEqual(parseDuration("1h 30m 15s"), 5_415_000);
    assert.strictEqual(parseDuration("1.5m"), 90_000);
  });

  it("rejects typos instead of guessing", () => {
    assert.strictEqual(parseDuration(""), undefined);
    assert.strictEqual(parseDuration(undefined), undefined);
    assert.strictEqual(parseDuration("10x"), undefined);
    assert.strictEqual(parseDuration("1m5"), undefined);
    assert.strictEqual(parseDuration("0"), undefined);
    assert.strictEqual(parseDuration("0m"), undefined);
    assert.strictEqual(parseDuration("-5m"), undefined);
  });

  it("round-trips with formatDuration", () => {
    assert.strictEqual(formatDuration(parseDuration("2m")!), "2m");
    assert.strictEqual(formatDuration(parseDuration("1h30m")!), "1h 30m");
  });
});
