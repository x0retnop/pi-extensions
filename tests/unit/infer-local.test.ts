import assert from "node:assert";
import { describe, it } from "node:test";

import {
  aliasToRow,
  chatAliases,
  maxTokensFor,
  parseSnapshot,
  presetNamesFor,
  presetProviderId,
  presetPublished,
  rowsForSnapshot,
  DEFAULT_MAX_TOKENS_CAP,
  DEFAULT_THINKING_LEVEL_MAP,
} from "../../infer-local/gateway.js";

// Shapes captured from the live gateway (2026-09-30): /v1/models, /v1/profiles, /v1/presets.
const MODELS = {
  object: "list",
  data: [
    { id: "gemma4-E4B-uncensored", object: "model", owned_by: "infer-gateway", kind: "chat" },
    { id: "qwen3-embed", object: "model", owned_by: "infer-gateway", kind: "embeddings" },
  ],
};

const PROFILES = {
  object: "list",
  data: [
    {
      alias: "gemma4-E4B-uncensored",
      kind: "chat",
      description: "Gemma 4 E4B abliterated Q8_0",
      capabilities: { tools: true, vision: true, reasoning: true, json: true, streaming: true },
      ctx_max: 65536,
      latency_class: "medium",
      status: "degraded",
    },
    { alias: "qwen3-embed", kind: "embeddings", capabilities: { vision: false, reasoning: false }, ctx_max: 8192 },
  ],
};

const PRESETS = {
  object: "list",
  data: [
    { alias: "gemma4-E4B-uncensored", name: "chat", source: "card", preset: {} },
    { alias: "gemma4-E4B-uncensored", name: "sub-agents-recon", source: "local", preset: {} },
    { alias: "gemma4-E4B-uncensored", name: "sub-agents-recon", source: "local", preset: {} },
    { alias: "qwen3-embed", name: "ignored", source: "card", preset: {} },
  ],
};

describe("infer-local parseSnapshot", () => {
  it("merges models, profiles and presets and drops non-chat aliases from the row set", () => {
    const snap = parseSnapshot("http://127.0.0.1:8090/v1", MODELS, PROFILES, PRESETS);
    assert.deepStrictEqual(
      snap.aliases.map((a) => [a.alias, a.kind, a.ctxMax]),
      [
        ["gemma4-E4B-uncensored", "chat", 65536],
        ["qwen3-embed", "embeddings", 8192],
      ],
    );
    assert.deepStrictEqual(chatAliases(snap).map((a) => a.alias), ["gemma4-E4B-uncensored"]);
    assert.deepStrictEqual(presetNamesFor(snap, "gemma4-E4B-uncensored"), ["chat", "sub-agents-recon"]);
    assert.deepStrictEqual(presetNamesFor(snap), ["chat", "ignored", "sub-agents-recon"]);
  });

  it("survives a missing profiles/presets payload", () => {
    const snap = parseSnapshot("http://127.0.0.1:8090/v1", MODELS);
    assert.strictEqual(snap.aliases[0].kind, "chat"); // from the model list
    assert.strictEqual(snap.aliases[0].ctxMax, undefined);
    assert.deepStrictEqual(snap.presets, {});
  });

  it("throws when /v1/models is not a model list", () => {
    assert.throws(() => parseSnapshot("http://127.0.0.1:8090/v1", { detail: "Not Found" }), /no model list/);
  });
});

describe("infer-local rows", () => {
  it("keeps the gateway alias as the model id (it is the route key) and adds the preset to the name", () => {
    const snap = parseSnapshot("http://127.0.0.1:8090/v1", MODELS, PROFILES, PRESETS);
    const [plain] = rowsForSnapshot(snap);
    assert.strictEqual(plain.id, "gemma4-E4B-uncensored");
    assert.strictEqual(plain.name, "gemma4-E4B-uncensored");
    assert.deepStrictEqual(plain.input, ["text", "image"]);
    assert.strictEqual(plain.reasoning, true);
    assert.strictEqual(plain.contextWindow, 65536);
    assert.strictEqual(plain.maxTokens, 16384);

    const [variant] = rowsForSnapshot(snap, { preset: "sub-agents-recon" });
    assert.strictEqual(variant.id, "gemma4-E4B-uncensored");
    assert.strictEqual(variant.name, "gemma4-E4B-uncensored · sub-agents-recon");
  });

  it("advertises vision only from the profile capability", () => {
    const textOnly = aliasToRow({ alias: "x", kind: "chat", ctxMax: 32768, capabilities: { reasoning: false } });
    assert.deepStrictEqual(textOnly.input, ["text"]);
    assert.strictEqual(textOnly.reasoning, false);
    assert.strictEqual(textOnly.maxTokens, 8192);
  });

  it("falls back to the default context window when the profile has none", () => {
    const row = aliasToRow({ alias: "x", kind: "chat" });
    assert.strictEqual(row.contextWindow, 65536);
    assert.strictEqual(row.maxTokens, 16384);
  });

  it("caps max tokens at ctx/4 and never below the floor", () => {
    assert.strictEqual(maxTokensFor(65536), 16384);
    assert.strictEqual(maxTokensFor(1048576), DEFAULT_MAX_TOKENS_CAP);
    assert.strictEqual(maxTokensFor(4096), 2048);
    assert.strictEqual(maxTokensFor(1048576, 4096), 4096);
  });
});

describe("infer-local thinking levels", () => {
  it("maps Pi levels onto the effort values the local chat templates accept", () => {
    const row = aliasToRow({ alias: "x", kind: "chat" });
    assert.deepStrictEqual(row.thinkingLevelMap, DEFAULT_THINKING_LEVEL_MAP);
    assert.deepStrictEqual(row.thinkingLevelMap, {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "xhigh",
      xhigh: "xhigh",
      max: "xhigh",
    });
  });

  it("never maps a level to a value outside {low, medium, xhigh} (anything else is a 500)", () => {
    for (const value of Object.values(DEFAULT_THINKING_LEVEL_MAP)) {
      assert.ok(["low", "medium", "xhigh"].includes(String(value)), `unexpected effort: ${value}`);
    }
  });

  it("leaves `off` absent so the level stays selectable and sends no reasoning_effort", () => {
    // `null` would filter the level out of getSupportedThinkingLevels(); absent keeps it.
    assert.strictEqual("off" in DEFAULT_THINKING_LEVEL_MAP, false);
  });

  it("accepts a per-config override", () => {
    const row = aliasToRow({ alias: "x", kind: "chat" }, { thinkingLevelMap: { high: "medium" } });
    assert.deepStrictEqual(row.thinkingLevelMap, { high: "medium" });
  });
});

describe("infer-local presetPublished", () => {
  const snap = parseSnapshot("http://127.0.0.1:8090/v1", MODELS, PROFILES, PRESETS);

  it("accepts a name published for the live chat alias", () => {
    assert.strictEqual(presetPublished(snap, "sub-agents-recon"), true);
  });

  it("rejects a name the gateway does not publish (would be a 400)", () => {
    assert.strictEqual(presetPublished(snap, "agents"), false);
    assert.strictEqual(presetPublished(snap, ""), false);
    assert.strictEqual(presetPublished(null, "agents"), false);
  });

  it("requires every chat alias to publish it (one provider header serves them all)", () => {
    const twoAliases = parseSnapshot(
      "http://127.0.0.1:8090/v1",
      { object: "list", data: [{ id: "a", kind: "chat" }, { id: "b", kind: "chat" }] },
      undefined,
      { object: "list", data: [{ alias: "a", name: "shared" }] },
    );
    assert.strictEqual(presetPublished(twoAliases, "shared"), false);
  });
});

describe("infer-local provider ids", () => {
  it("slugifies preset names", () => {
    assert.strictEqual(presetProviderId("infer", "sub-agents-recon"), "infer-sub-agents-recon");
    assert.strictEqual(presetProviderId("infer", "ghostweave/curate"), "infer-ghostweave-curate");
    assert.strictEqual(presetProviderId("infer", "--"), "infer");
  });
});
