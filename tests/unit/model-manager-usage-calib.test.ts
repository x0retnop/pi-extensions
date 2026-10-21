import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function pathToFileURL(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (normalized.startsWith("/") ? normalized.slice(1) : normalized);
}

// Isolate from real ~/.pi/agent (Pi uses PI_CODING_AGENT_DIR).
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "mm-usage-calib-test-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const {
  getTokensPerQuotaUnit,
  getListDollarsPerQuotaUnit,
  getKimiCalibStats,
  getListDollarsPerWeeklyPct,
  parseOpencodeGoPayload,
  estimateUsageCost,
  computeUsageDeltas,
  computeWeekConsumption,
  isUsageMeterReset,
  selectCalibPointsToKeep,
} = await import(
  pathToFileURL(path.join(root, "model-manager", "usage.js"))
);

after(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  try {
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const CALIB = "model-manager-usage-calib.jsonl";

function writeCalib(lines: unknown[]): void {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(tmpAgent, CALIB), body, "utf-8");
}

function sess(over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; apiCost: number; turns: number }> = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    apiCost: 0,
    turns: 0,
    ...over,
  };
}

// Minimal ctx for estimateUsageCost: registry with one model per provider.
function makeCtx(models: Array<{ provider: string; baseUrl?: string; id: string; cost: Record<string, number> }>, modelId?: string) {
  return {
    modelRegistry: { getAll: () => models },
    model: modelId ? { id: modelId } : undefined,
  } as unknown as Parameters<typeof estimateUsageCost>[0];
}

const KIMI_MODEL = {
  provider: "kimi-main-ant",
  baseUrl: "https://api.kimi.com/coding",
  id: "k3",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
};

describe("getTokensPerQuotaUnit", () => {
  it("returns undefined when the calib file is missing", () => {
    assert.equal(getTokensPerQuotaUnit("kimi"), undefined);
  });

  it("derives tokens per quota unit from same-session consecutive fetches", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 50 }, sess: sess({ input: 100000, output: 50000, cacheRead: 200000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 55 }, sess: sess({ input: 200000, output: 80000, cacheRead: 300000 }) },
    ]);
    // dq=5, dt=(200000-100000)+(80000-50000)+(300000-200000)=230000 → 46000
    assert.equal(getTokensPerQuotaUnit("kimi"), 46000);
  });

  it("ignores pairs across different sessions and non-positive window deltas", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 50 }, sess: sess({ input: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi", sessionId: "s2", windows: { "Weekly limit": 55 }, sess: sess({ input: 200000 }) },
      { at: "2026-08-08T08:00:00Z", providerId: "kimi", sessionId: "s2", windows: { "Weekly limit": 55 }, sess: sess({ input: 300000 }) },
    ]);
    // pair 1: session changed → skipped; pair 2: dq=0 → skipped
    assert.equal(getTokensPerQuotaUnit("kimi"), undefined);
  });

  it("uses the weekly window first and never sums weekly + 5h for the same pair", () => {
    writeCalib([
      {
        at: "2026-08-08T06:00:00Z",
        providerId: "kimi",
        sessionId: "s1",
        windows: { "Weekly limit": 50, "5h limit": 20 },
        sess: sess({ input: 100000, output: 10000, cacheRead: 200000 }),
      },
      {
        at: "2026-08-08T07:00:00Z",
        providerId: "kimi",
        sessionId: "s1",
        windows: { "Weekly limit": 55, "5h limit": 30 },
        sess: sess({ input: 200000, output: 20000, cacheRead: 300000 }),
      },
    ]);
    // dt = 100000+10000+100000 = 210000 over dq=5 (5h delta 10 ignored) → 42000
    assert.equal(getTokensPerQuotaUnit("kimi"), 42000);
  });

  it("keeps only the last point per pair sequence but aggregates all valid pairs", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 50 }, sess: sess({ input: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 52 }, sess: sess({ input: 120000 }) },
      { at: "2026-08-08T08:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 55 }, sess: sess({ input: 150000 }) },
      { at: "2026-08-08T09:00:00Z", providerId: "kimi", sessionId: "s1", windows: { "Weekly limit": 60 }, sess: sess({ input: 200000 }) },
    ]);
    // pairs (s1): dq=2/dt=20000, dq=3/dt=30000, dq=5/dt=50000 → 100000/10 = 10000
    assert.equal(getTokensPerQuotaUnit("kimi"), 10000);
  });

  it("separates k3 and k3-256k ratios when modelId is given", () => {
    writeCalib([
      // k3-256k pair: dq=5, dt=500000 → 100000 tokens/unit
      { at: "2026-08-08T06:00:00Z", providerId: "kimi", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 50 }, sess: sess({ input: 300000, output: 100000, cacheRead: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 55 }, sess: sess({ input: 600000, output: 200000, cacheRead: 200000 }) },
      // k3 pair: same tokens (500000), but quota meter charges 2× → dq=10 → 50000 tokens/unit
      { at: "2026-08-08T08:00:00Z", providerId: "kimi", sessionId: "s2", model: "k3", windows: { "Weekly limit": 60 }, sess: sess({ input: 300000, output: 100000, cacheRead: 100000 }) },
      { at: "2026-08-08T09:00:00Z", providerId: "kimi", sessionId: "s2", model: "k3", windows: { "Weekly limit": 70 }, sess: sess({ input: 600000, output: 200000, cacheRead: 200000 }) },
    ]);
    assert.equal(getTokensPerQuotaUnit("kimi", "k3-256k"), 100000);
    assert.equal(getTokensPerQuotaUnit("kimi", "k3"), 50000);
    // blended fallback mixes both: (500000+500000)/(5+10) ≈ 66666.67
    const blended = getTokensPerQuotaUnit("kimi");
    assert.ok(blended && Math.abs(blended - 66666.6667) < 0.01);
  });

  it("excludes pairs whose model changed mid-session from per-model ratios", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi", sessionId: "s1", model: "k3", windows: { "Weekly limit": 50 }, sess: sess({ input: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 55 }, sess: sess({ input: 200000 }) },
    ]);
    // model changed between the two fetches → no per-model pair and no blend
    assert.equal(getTokensPerQuotaUnit("kimi", "k3"), undefined);
    assert.equal(getTokensPerQuotaUnit("kimi", "k3-256k"), undefined);
    assert.equal(getTokensPerQuotaUnit("kimi"), undefined);
  });

  it("uses sessModel for per-model ratios when both points have it", () => {
    writeCalib([
      {
        at: "2026-08-08T06:00:00Z",
        providerId: "kimi",
        sessionId: "s1",
        model: "k3-256k",
        windows: { "Weekly limit": 50 },
        sess: sess({ input: 900000, output: 100000, cacheRead: 100000 }),
        sessModel: sess({ input: 100000, output: 20000, cacheRead: 40000 }),
      },
      {
        at: "2026-08-08T07:00:00Z",
        providerId: "kimi",
        sessionId: "s1",
        model: "k3-256k",
        windows: { "Weekly limit": 52 },
        sess: sess({ input: 1200000, output: 200000, cacheRead: 400000 }),
        sessModel: sess({ input: 200000, output: 40000, cacheRead: 80000 }),
      },
    ]);
    // per-model uses sessModel: dt=(100000+20000+40000)=160000 / dq=2 → 80000
    assert.equal(getTokensPerQuotaUnit("kimi", "k3-256k"), 80000);
  });

  it("skips cache-bomb pairs (tiny quota tick, almost only cache)", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi", sessionId: "s1", model: "kimi-for-coding", windows: { "Weekly limit": 99 }, sess: sess({ input: 10000, output: 5000, cacheRead: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi", sessionId: "s1", model: "kimi-for-coding", windows: { "Weekly limit": 100 }, sess: sess({ input: 15000, output: 8000, cacheRead: 5_000_000 }) },
    ]);
    // dq=1, fresh=8000, cache=4.9M → bomb
    assert.equal(getTokensPerQuotaUnit("kimi", "kimi-for-coding"), undefined);
    assert.equal(getListDollarsPerQuotaUnit("kimi", "kimi-for-coding"), undefined);
  });

  it("skips a weekly reset instead of falling through to the 5h delta", () => {
    writeCalib([
      {
        at: "2026-08-23T15:39:00Z",
        providerId: "kimi",
        sessionId: "s1",
        model: "k3-256k",
        windows: { "Weekly limit": 94, "5h limit": 48 },
        sess: sess({ input: 20000, output: 6000, cacheRead: 300000 }),
        sessModel: sess({ input: 20000, output: 6000, cacheRead: 300000 }),
      },
      {
        at: "2026-08-23T16:07:00Z",
        providerId: "kimi",
        sessionId: "s1",
        model: "k3-256k",
        windows: { "Weekly limit": 5, "5h limit": 88 },
        sess: sess({ input: 120000, output: 50000, cacheRead: 8_000_000 }),
        sessModel: sess({ input: 120000, output: 50000, cacheRead: 8_000_000 }),
      },
    ]);
    // weekly 94→5 is a reset; 5h +40 must not become a pair
    assert.equal(getTokensPerQuotaUnit("kimi", "k3-256k"), undefined);
    assert.equal(getListDollarsPerQuotaUnit("kimi", "k3-256k"), undefined);
    assert.equal(getKimiCalibStats("kimi", "k3-256k"), undefined);
  });

  it("keeps a clean pair when a later weekly-reset pair is in the same file", () => {
    writeCalib([
      {
        at: "2026-08-22T13:11:00Z",
        providerId: "kimi",
        sessionId: "s1",
        model: "k3-256k",
        windows: { "Weekly limit": 64, "5h limit": 0 },
        sess: sess({ input: 0, output: 0, cacheRead: 0 }),
        sessModel: sess({ input: 0, output: 0, cacheRead: 0 }),
      },
      {
        at: "2026-08-22T13:47:00Z",
        providerId: "kimi",
        sessionId: "s1",
        model: "k3-256k",
        windows: { "Weekly limit": 76, "5h limit": 64 },
        sess: sess({ input: 309435, output: 32190, cacheRead: 1906415 }),
        sessModel: sess({ input: 309435, output: 32190, cacheRead: 1906415 }),
      },
      {
        at: "2026-08-23T15:39:00Z",
        providerId: "kimi",
        sessionId: "s2",
        model: "k3-256k",
        windows: { "Weekly limit": 94, "5h limit": 48 },
        sess: sess({ input: 20000, output: 6000, cacheRead: 300000 }),
        sessModel: sess({ input: 20000, output: 6000, cacheRead: 300000 }),
      },
      {
        at: "2026-08-23T16:07:00Z",
        providerId: "kimi",
        sessionId: "s2",
        model: "k3-256k",
        windows: { "Weekly limit": 5, "5h limit": 88 },
        sess: sess({ input: 120000, output: 50000, cacheRead: 8_000_000 }),
        sessModel: sess({ input: 120000, output: 50000, cacheRead: 8_000_000 }),
      },
    ]);
    // only s1 dq=12 survives
    const stats = getKimiCalibStats("kimi", "k3-256k");
    assert.ok(stats);
    assert.equal(stats.pairs, 1);
    assert.equal(stats.totalQuota, 12);
    assert.equal(stats.lastAt, "2026-08-22T13:47:00Z");
    const dollars = (309435 * 3 + 32190 * 15 + 1906415 * 0.3) / 1e6;
    assert.ok(Math.abs(stats.dollarsPerUnit - dollars / 12) < 1e-9);
  });
});

describe("estimateUsageCost", () => {
  it("non-Kimi provider keeps the direct delta × $/token estimate", () => {
    const ctx = makeCtx([
      { provider: "other", id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ]);
    const est = estimateUsageCost(ctx, "other", 10);
    assert.deepEqual(est, { min: 0.00003, max: 0.00003, avg: 0.00003 });
  });

  it("Kimi provider returns undefined until calibration data exists", () => {
    const ctx = makeCtx([KIMI_MODEL]);
    assert.equal(estimateUsageCost(ctx, "kimi-main-ant", 8), undefined);
  });

  it("Kimi provider converts quota delta via calib list-$ / quota unit", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi-main-ant", sessionId: "s1", model: "k3", windows: { "Weekly limit": 50 }, sess: sess({ input: 100000, output: 50000, cacheRead: 200000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi-main-ant", sessionId: "s1", model: "k3", windows: { "Weekly limit": 55 }, sess: sess({ input: 200000, output: 80000, cacheRead: 300000 }) },
    ]);
    const ctx = makeCtx([KIMI_MODEL], "k3");
    // ds: in=100000 out=30000 cr=100000 → (100000*3 + 30000*15 + 100000*0.3)/1e6 = 0.78
    const est = estimateUsageCost(ctx, "kimi-main-ant", 5);
    assert.ok(est);
    assert.ok(Math.abs(est.min - 0.78) < 1e-9);
    assert.equal(est.min, est.max);
  });

  it("uses the active model's per-model ratio when available", () => {
    writeCalib([
      // k3-256k pair: dq=5, dt=500000 → 100000 tokens/unit
      { at: "2026-08-08T06:00:00Z", providerId: "kimi-main-ant", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 50 }, sess: sess({ input: 300000, output: 100000, cacheRead: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi-main-ant", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 55 }, sess: sess({ input: 600000, output: 200000, cacheRead: 200000 }) },
      // k3 pair: same tokens, quota meter 2× → dq=10 → 50000 tokens/unit
      { at: "2026-08-08T08:00:00Z", providerId: "kimi-main-ant", sessionId: "s2", model: "k3", windows: { "Weekly limit": 60 }, sess: sess({ input: 300000, output: 100000, cacheRead: 100000 }) },
      { at: "2026-08-08T09:00:00Z", providerId: "kimi-main-ant", sessionId: "s2", model: "k3", windows: { "Weekly limit": 70 }, sess: sess({ input: 600000, output: 200000, cacheRead: 200000 }) },
    ]);
    // same tokens on both models: (300000*3 + 100000*15 + 100000*0.3)/1e6 = 2.43
    const ctx256 = makeCtx([KIMI_MODEL], "k3-256k");
    const est256 = estimateUsageCost(ctx256, "kimi-main-ant", 5);
    assert.ok(est256);
    assert.ok(Math.abs(est256.min - 2.43) < 1e-9);
    const ctx3 = makeCtx([KIMI_MODEL], "k3");
    const est3 = estimateUsageCost(ctx3, "kimi-main-ant", 10);
    assert.ok(est3);
    assert.ok(Math.abs(est3.min - 2.43) < 1e-9);
  });

  it("falls back to the blended ratio when the active model has no pairs yet", () => {
    writeCalib([
      { at: "2026-08-08T06:00:00Z", providerId: "kimi-main-ant", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 50 }, sess: sess({ input: 300000, output: 100000, cacheRead: 100000 }) },
      { at: "2026-08-08T07:00:00Z", providerId: "kimi-main-ant", sessionId: "s1", model: "k3-256k", windows: { "Weekly limit": 55 }, sess: sess({ input: 600000, output: 200000, cacheRead: 200000 }) },
    ]);
    // active model k3 has no own pairs → k3-256k pair blend: $2.43 / 5 units × 5
    const ctx3 = makeCtx([KIMI_MODEL], "k3");
    const est = estimateUsageCost(ctx3, "kimi-main-ant", 5);
    assert.ok(est);
    assert.ok(Math.abs(est.min - 2.43) < 1e-9);
  });

  it("returns undefined for delta <= 0", () => {
    const ctx = makeCtx([KIMI_MODEL]);
    assert.equal(estimateUsageCost(ctx, "kimi-main-ant", 0), undefined);
    assert.equal(estimateUsageCost(ctx, "kimi-main-ant", -3), undefined);
  });
});

const XAI_MODEL = {
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  id: "grok-4.5",
  cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
};

function xaiPt(
  at: string,
  sessionId: string,
  weekly: number,
  apiCost: number,
  over: Record<string, unknown> = {},
) {
  return {
    at,
    providerId: "xai",
    sessionId,
    model: "grok-4.5",
    windows: { "Weekly limit": weekly },
    sess: { ...sess(), apiCost, turns: 0 },
    ...over,
  };
}

describe("getListDollarsPerWeeklyPct", () => {
  it("returns undefined when calib is missing", () => {
    assert.equal(getListDollarsPerWeeklyPct("xai"), undefined);
  });

  it("derives list-$ per weekly-% from same-session apiCost deltas", () => {
    // Three +4% / $1.80 slices → ΣΔ%=12 (≥8), $0.45 / %
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s1", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "s1", 64, 1.8),
      xaiPt("2026-08-11T17:00:00Z", "s1", 68, 3.6),
      xaiPt("2026-08-11T18:00:00Z", "s1", 72, 5.4),
    ]);
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai") ?? 0) - 0.45) < 1e-9);
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai", "grok-4.5") ?? 0) - 0.45) < 1e-9);
  });

  it("ignores a single clean pair until ΣΔ% ≥ 8 (seed stays in charge)", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s1", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "s1", 64, 1.8),
    ]);
    assert.equal(getListDollarsPerWeeklyPct("xai"), undefined);
  });

  it("drops Δ% < 3 even when $/pct looks like the seed", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s1", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "s1", 64, 1.8),
      xaiPt("2026-08-11T16:30:00Z", "s1", 66, 2.7), // +2% / $0.90 = 0.45 — integer noise
      xaiPt("2026-08-11T17:30:00Z", "s1", 70, 4.5),
    ]);
    // +2% dropped; remaining +4 +4 = 8% at $0.45
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai") ?? 0) - 0.45) < 1e-9);
  });

  it("skips a pair when another session opened /usage in the interval, even if % did not tick", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "sA", 60, 0),
      xaiPt("2026-08-11T15:30:00Z", "sB", 60, 0.2),
      xaiPt("2026-08-11T16:00:00Z", "sA", 64, 1.8),
      xaiPt("2026-08-11T17:00:00Z", "sC", 64, 0),
      xaiPt("2026-08-11T18:00:00Z", "sC", 68, 1.8),
    ]);
    // sA contaminated by sB; sC is a lone +4% — underweight
    assert.equal(getListDollarsPerWeeklyPct("xai"), undefined);
  });

  it("skips pairs contaminated by another session moving the weekly meter", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "sA", 60, 0),
      xaiPt("2026-08-11T15:30:00Z", "sB", 65, 2.0),
      xaiPt("2026-08-11T16:00:00Z", "sA", 70, 1.8),
    ]);
    assert.equal(getListDollarsPerWeeklyPct("xai"), undefined);
  });

  it("ignores old monthly-plan points and $/pct outliers", () => {
    writeCalib([
      xaiPt("2026-08-08T12:00:00Z", "old", 40, 0, {
        model: "grok-4.5",
        monthlyLimit: 15000,
        windows: { "Monthly limit": 5000, "Weekly limit": 40 },
      }),
      xaiPt("2026-08-08T13:00:00Z", "old", 44, 1.8, {
        model: "grok-4.5",
        monthlyLimit: 15000,
        windows: { "Monthly limit": 5200, "Weekly limit": 44 },
      }),
      xaiPt("2026-08-17T10:00:00Z", "s1", 79, 4.0, { model: "grok-4.6" }),
      // +1% / $8.61 — integer-% noise; must not dominate.
      xaiPt("2026-08-17T11:00:00Z", "s1", 80, 12.61, { model: "grok-4.6" }),
      xaiPt("2026-08-11T15:00:00Z", "s2", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "s2", 64, 1.8),
      xaiPt("2026-08-12T10:00:00Z", "s3", 70, 0),
      xaiPt("2026-08-12T11:00:00Z", "s3", 74, 1.8),
    ]);
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai") ?? 0) - 0.45) < 1e-9);
    // 4.5/4.6 share the weekly bar and list rates — modelId is ignored.
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai", "grok-4.6") ?? 0) - 0.45) < 1e-9);
  });

  it("does not treat a long-context 4.6 cache-bomb as a different model rate", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s2", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "s2", 64, 1.8),
      xaiPt("2026-08-12T10:00:00Z", "s3", 70, 0),
      xaiPt("2026-08-12T11:00:00Z", "s3", 74, 1.8),
      xaiPt("2026-08-15T03:21:00Z", "fat", 55, 0, { model: "grok-4.6" }),
      xaiPt("2026-08-15T04:27:00Z", "fat", 61, 10.8, {
        model: "grok-4.6",
        sess: {
          input: 460964,
          output: 45158,
          cacheRead: 19207040,
          cacheWrite: 0,
          apiCost: 10.8,
          turns: 125,
        },
      }),
    ]);
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai") ?? 0) - 0.45) < 1e-9);
    assert.ok(Math.abs((getListDollarsPerWeeklyPct("xai", "grok-4.6") ?? 0) - 0.45) < 1e-9);
  });

  it("drops $/pct outside 0.20–0.80 even when Δ% ≥ 3", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "low", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "low", 64, 0.4), // $0.10/% — parallel ate the bar
      xaiPt("2026-08-11T17:00:00Z", "hi", 70, 0),
      xaiPt("2026-08-11T18:00:00Z", "hi", 74, 4.0), // $1.00/% — 200k-cliff-ish
    ]);
    assert.equal(getListDollarsPerWeeklyPct("xai"), undefined);
  });

  it("ignores cross-session pairs and non-positive weekly deltas", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s1", 60, 0.5),
      xaiPt("2026-08-11T16:00:00Z", "s2", 65, 2.0),
      xaiPt("2026-08-11T17:00:00Z", "s2", 65, 2.5),
    ]);
    assert.equal(getListDollarsPerWeeklyPct("xai"), undefined);
  });
});

describe("estimateUsageCost xAI weekly", () => {
  it("keeps the $0.45 seed until live pairs sum to Δ% ≥ 8", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s1", 60, 0),
      // +4% / $2.40 = $0.60/% — would pull overlay off seed if one pair counted
      xaiPt("2026-08-11T16:00:00Z", "s1", 64, 2.4),
    ]);
    const ctx = makeCtx([XAI_MODEL], "grok-4.5");
    const est = estimateUsageCost(ctx, "xai", 3, "Weekly limit");
    assert.ok(est);
    assert.ok(Math.abs(est.avg - 1.35) < 1e-9);
    assert.equal(est.min, est.max);
  });

  it("uses live calib list-$/pct once ΣΔ% ≥ 8", () => {
    writeCalib([
      xaiPt("2026-08-11T15:00:00Z", "s1", 60, 0),
      xaiPt("2026-08-11T16:00:00Z", "s1", 64, 2.4),
      xaiPt("2026-08-12T10:00:00Z", "s2", 70, 0),
      xaiPt("2026-08-12T11:00:00Z", "s2", 74, 2.4),
    ]);
    const ctx = makeCtx([XAI_MODEL], "grok-4.5");
    // live $0.60/% × 2 = $1.20 (not seed $0.90)
    const est = estimateUsageCost(ctx, "xai", 2, "Weekly limit");
    assert.ok(est);
    assert.ok(Math.abs(est.avg - 1.2) < 1e-9);
  });

  it("falls back to grok-4.5 seed when calib has no pairs", () => {
    writeCalib([]);
    const ctx = makeCtx([XAI_MODEL], "grok-4.5");
    const est = estimateUsageCost(ctx, "xai", 2, "Weekly limit");
    assert.ok(est);
    // seed 0.45 × 2 = 0.90
    assert.ok(Math.abs(est.avg - 0.9) < 1e-9);
  });

  it("uses the same $0.45 seed for grok-4.6 (same list rates as 4.5)", () => {
    writeCalib([]);
    const ctx = makeCtx([{ ...XAI_MODEL, id: "grok-4.6" }], "grok-4.6");
    const est = estimateUsageCost(ctx, "xai", 2, "Weekly limit");
    assert.ok(est);
    assert.ok(Math.abs(est.avg - 0.9) < 1e-9);
  });

  it("returns undefined for monthly window and unknown models without calib", () => {
    writeCalib([]);
    const ctx = makeCtx([{ ...XAI_MODEL, id: "grok-unknown" }], "grok-unknown");
    assert.equal(estimateUsageCost(ctx, "xai", 5, "Monthly limit"), undefined);
    assert.equal(estimateUsageCost(ctx, "xai", 5, "Weekly limit"), undefined);
  });

  it("does not treat weekly % as raw tokens (non-xai path)", () => {
    // Guard: xai with seed must NOT equal delta × (2+6)/1e6
    writeCalib([]);
    const ctx = makeCtx([XAI_MODEL], "grok-4.5");
    const est = estimateUsageCost(ctx, "xai", 10, "Weekly limit");
    assert.ok(est);
    assert.ok(est.avg > 1); // 10 × 0.45 = 4.5, not ~0.00008
  });
});

function hist(
  used: number,
  fetchedAt: string,
  over: Partial<{ providerId: string; label: string; limit: number; remaining: number }> = {},
) {
  return {
    providerId: "xai",
    label: "Weekly limit",
    used,
    limit: 100,
    remaining: 100 - used,
    fetchedAt,
    ...over,
  };
}

describe("computeWeekConsumption", () => {
  it("treats Weekly limit used as week-to-date when no reset is visible", () => {
    const history = [
      hist(41, "2026-08-18T20:40:00Z"),
      hist(48, "2026-08-19T08:06:00Z"),
    ];
    const w = computeWeekConsumption(history, "xai", "Weekly limit", 71, "2026-08-19T19:25:00Z");
    assert.ok(w);
    assert.equal(w.week, 71);
  });

  it("restarts the week sum after a meter reset", () => {
    const history = [
      hist(71, "2026-08-19T19:25:00Z"),
      hist(1, "2026-08-19T20:57:00Z"),
    ];
    const w = computeWeekConsumption(history, "xai", "Weekly limit", 3, "2026-08-19T21:30:00Z");
    assert.ok(w);
    assert.equal(w.week, 3);
  });

  it("sums positive deltas for non-weekly windows across retained history", () => {
    const history = [
      hist(2, "2026-08-18T08:00:00Z", { providerId: "kimi", label: "5h limit" }),
      hist(6, "2026-08-18T08:15:00Z", { providerId: "kimi", label: "5h limit" }),
      hist(12, "2026-08-18T08:30:00Z", { providerId: "kimi", label: "5h limit" }),
    ];
    const w = computeWeekConsumption(history, "kimi", "5h limit", 12, "2026-08-18T08:30:00Z");
    assert.ok(w);
    assert.equal(w.week, 10);
  });
});

describe("computeUsageDeltas week field", () => {
  it("exposes week alongside today / sinceLast", () => {
    const history = [
      hist(41, "2026-08-18T20:40:00Z"),
      hist(48, "2026-08-19T08:06:00Z"),
    ];
    const d = computeUsageDeltas(history, "xai", "Weekly limit", 56, "2026-08-19T09:31:00Z");
    assert.equal(d.sinceLast, 8);
    assert.equal(d.today, 8);
    assert.equal(d.week, 56);
  });

  it("detects a weekly reset as a used drop", () => {
    assert.equal(isUsageMeterReset(71, 1), true);
    assert.equal(isUsageMeterReset(12, 11), false);
    const history = [hist(71, "2026-08-19T19:25:00Z")];
    const d = computeUsageDeltas(history, "xai", "Weekly limit", 1, "2026-08-19T20:57:00Z");
    assert.equal(d.week, 1);
    assert.ok(d.sinceLast !== undefined && d.sinceLast < 0);
  });
});

describe("selectCalibPointsToKeep", () => {
  const NOW = Date.parse("2026-08-26T12:00:00Z");
  const totals = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, apiCost: 0.1, turns: 1 };

  function pt(at: string, sessionId: string, over: Record<string, unknown> = {}) {
    return {
      at,
      providerId: "xai",
      sessionId,
      model: "grok-4.6",
      windows: { "Weekly limit": 10 },
      sess: totals,
      ...over,
    };
  }

  it("drops points older than 14d and unpaired sessions older than 3d", () => {
    const kept = selectCalibPointsToKeep(
      [
        pt("2026-08-10T12:00:00Z", "oldPair"),
        pt("2026-08-10T13:00:00Z", "oldPair"),
        pt("2026-08-20T12:00:00Z", "staleSingle"),
        pt("2026-08-20T12:00:00Z", "midPair"),
        pt("2026-08-20T13:00:00Z", "midPair"),
        pt("2026-08-25T12:00:00Z", "freshSingle"),
      ],
      NOW,
    );
    const sids = kept.map((p) => p.sessionId).sort();
    assert.deepEqual(sids, ["freshSingle", "midPair", "midPair"]);
  });

  it("strips derived d, weeklyPct, and sessModel when it equals sess", () => {
    const kept = selectCalibPointsToKeep(
      [
        pt("2026-08-25T12:00:00Z", "s1", {
          weeklyPct: 10,
          monthlyUsed: 0,
          monthlyLimit: 0,
          sessModel: totals,
          d: { dtMin: 3, windows: { "Weekly limit": 1 } },
        }),
      ],
      NOW,
    );
    assert.equal(kept.length, 1);
    assert.equal("d" in kept[0], false);
    assert.equal("weeklyPct" in kept[0], false);
    assert.equal("sessModel" in kept[0], false);
    assert.equal("monthlyLimit" in kept[0], false);
  });

  it("keeps sessModel only when it differs from sess", () => {
    const kept = selectCalibPointsToKeep(
      [
        pt("2026-08-25T12:00:00Z", "s1", {
          sessModel: { ...totals, input: 99 },
        }),
      ],
      NOW,
    );
    assert.equal(kept[0].sessModel?.input, 99);
  });
});

const OPENCODE_MODEL = {
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  id: "kimi-k2.7-code", // $60/mo limit
  cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
};

function ocPt(at: string, sessionId: string, windows: Record<string, number>, apiCost: number) {
  return {
    at,
    providerId: "opencode-go",
    sessionId,
    model: "kimi-k2.7-code",
    windows,
    sess: sess({ input: 1000000, output: 500000, apiCost }),
  };
}

// Reset instants are relative to the run: the payload is a live sample, but a frozen
// date turns every future run into "reset" (delta <= 0) and breaks the hint assertion.
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const OC_LIVE = {
  usage: {
    rolling: { status: "ok", percent: 6, resetsAt: hoursFromNow(3) },
    weekly: { status: "ok", percent: 2, resetsAt: hoursFromNow(72) },
    monthly: { status: "ok", percent: 1, resetsAt: hoursFromNow(500) },
  },
};

describe("parseOpencodeGoPayload", () => {
  it("maps the live /zen/go/v1/usage shape onto 100-unit windows, weekly first", () => {
    const windows = parseOpencodeGoPayload(OC_LIVE);
    assert.ok(windows);
    assert.deepEqual(
      windows.map((w) => w.label),
      ["Weekly limit", "Rolling 5h limit", "Monthly limit"],
    );
    const weekly = windows[0];
    assert.equal(weekly.used, 2);
    assert.equal(weekly.limit, 100);
    assert.equal(weekly.remaining, 98);
    assert.ok(weekly.resetHint?.startsWith("resets in"));
    assert.equal(windows[2].used, 1);
  });

  it("returns undefined for the Kimi flat-usage shape", () => {
    assert.equal(parseOpencodeGoPayload({ usage: { limit: 100, used: 42 } }), undefined);
    assert.equal(parseOpencodeGoPayload({ limits: [] }), undefined);
    assert.equal(parseOpencodeGoPayload(null), undefined);
  });
});

describe("estimateUsageCost opencode-go", () => {
  it("converts Δ% via the docs-table seed (weekly = 0.5×, rolling = 0.2× monthly)", () => {
    const ctx = makeCtx([OPENCODE_MODEL], "kimi-k2.7-code"); // $60/mo
    // weekly: 5% × (0.5×60)/100 = $1.50
    assert.ok(Math.abs((estimateUsageCost(ctx, "opencode-go", 5, "Weekly limit")?.avg ?? 0) - 1.5) < 1e-9);
    // rolling 5h: 5% × (0.2×60)/100 = $0.60
    assert.ok(Math.abs((estimateUsageCost(ctx, "opencode-go", 5, "Rolling 5h limit")?.avg ?? 0) - 0.6) < 1e-9);
    // monthly: 5% × 60/100 = $3.00
    assert.ok(Math.abs((estimateUsageCost(ctx, "opencode-go", 5, "Monthly limit")?.avg ?? 0) - 3.0) < 1e-9);
  });

  it("returns undefined for a model missing from the limits table when calib is not ready", () => {
    const ctx = makeCtx([{ ...OPENCODE_MODEL, id: "space-bunny-free" }], "space-bunny-free");
    assert.equal(estimateUsageCost(ctx, "opencode-go", 5, "Weekly limit"), undefined);
  });

  it("ignores calib pairs entirely — the docs table is the meter definition", () => {
    // Plausible-looking same-session pair ($0.60/pct ≠ table's $0.30/pct) must
    // NOT override the seed: mixed-model apiCost averages unrelated price tiers.
    writeCalib([
      ocPt("2026-09-20T10:00:00Z", "s1", { "Weekly limit": 10 }, 0),
      ocPt("2026-09-20T11:00:00Z", "s1", { "Weekly limit": 20 }, 6.0),
    ]);
    const ctx = makeCtx([OPENCODE_MODEL], "kimi-k2.7-code");
    assert.ok(Math.abs((estimateUsageCost(ctx, "opencode-go", 5, "Weekly limit")?.avg ?? 0) - 1.5) < 1e-9);
  });
});
