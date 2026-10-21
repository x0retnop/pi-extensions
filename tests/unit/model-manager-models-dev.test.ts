import assert from "node:assert";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function pathToFileURL(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (normalized.startsWith("/") ? normalized.slice(1) : normalized);
}

const { pickModelsDevSpecs, MODELS_DEV_PROVIDERS } = await import(
  pathToFileURL(path.join(root, "model-manager", "models-dev.js"))
);
const { patchCuratedModelDef, toPiInput, OPENCODE_GO_BASE_URL } = await import(
  pathToFileURL(path.join(root, "model-manager", "wire-compat.js"))
);

/** Trimmed models.dev payload (shape verified against the live api.json). */
const payload = {
  "opencode-go": {
    models: {
      "deepseek-v4.1-flash": {
        family: "deepseek-flash",
        knowledge: "2025-05",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1000000, output: 384000 },
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
      "kimi-k3": {
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1048576, output: 131072 },
      },
      "no-specs-at-all": {},
      "minimax-m3": {
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 0, output: -1 },
        knowledge: "  ",
        // Tiered price (cost.tiers) — only the base rate must survive.
        cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.1, tiers: [{ input: 0.6 }] },
      },
      "cost-only": { cost: { input: 1, output: 2 } },
    },
  },
  openrouter: { models: { "deepseek/deepseek-v4.1-flash": { limit: { context: 1000000 } } } },
};

describe("model-manager models.dev pick", () => {
  it("extracts limit, modalities and knowledge for requested ids only", () => {
    const specs = pickModelsDevSpecs(payload, "opencode-go", ["deepseek-v4.1-flash", "kimi-k3"]);
    assert.deepStrictEqual(Object.keys(specs).sort(), ["deepseek-v4.1-flash", "kimi-k3"]);
    assert.strictEqual(specs["deepseek-v4.1-flash"].contextWindow, 1000000);
    assert.strictEqual(specs["deepseek-v4.1-flash"].maxTokens, 384000);
    assert.deepStrictEqual(specs["deepseek-v4.1-flash"].inputModalities, ["text", "image"]);
    assert.deepStrictEqual(specs["deepseek-v4.1-flash"].outputModalities, ["text"]);
    assert.strictEqual(specs["deepseek-v4.1-flash"].knowledge, "2025-05");
    // Cost is USD per 1M — same unit as Pi Model.cost.
    assert.strictEqual(specs["deepseek-v4.1-flash"].costInput, 0.15);
    assert.strictEqual(specs["deepseek-v4.1-flash"].costOutput, 0.6);
    assert.strictEqual(specs["deepseek-v4.1-flash"].costCacheRead, 0.003);
    assert.strictEqual(specs["deepseek-v4.1-flash"].costCacheWrite, undefined);
  });

  it("extracts the base cost, ignoring tiers and cache_write when absent", () => {
    const specs = pickModelsDevSpecs(payload, "opencode-go", ["minimax-m3", "cost-only"]);
    assert.strictEqual(specs["minimax-m3"].costInput, 0.3);
    assert.strictEqual(specs["minimax-m3"].costCacheWrite, 0.1);
    assert.strictEqual((specs["minimax-m3"] as any).tiers, undefined);
    // A model whose only usable field is cost is still kept.
    assert.deepStrictEqual(specs["cost-only"], { costInput: 1, costOutput: 2 });
  });

  it("drops an output limit that just repeats the context window", () => {
    // Real shape: kimi-k2.7-code 262144/262144 on opencode-go.
    const specs = pickModelsDevSpecs(
      { "opencode-go": { models: { m: { limit: { context: 262144, output: 262144 } } } } },
      "opencode-go",
      ["m"],
    );
    assert.strictEqual(specs.m.contextWindow, 262144);
    assert.strictEqual(specs.m.maxTokens, undefined);
  });

  it("keeps a plausible output limit", () => {
    const specs = pickModelsDevSpecs(
      { "opencode-go": { models: { m: { limit: { context: 1000000, output: 384000 } } } } },
      "opencode-go",
      ["m"],
    );
    assert.strictEqual(specs.m.maxTokens, 384000);
  });

  it("drops models with nothing usable and non-positive limits", () => {
    const specs = pickModelsDevSpecs(payload, "opencode-go", ["no-specs-at-all", "minimax-m3"]);
    assert.deepStrictEqual(Object.keys(specs), ["minimax-m3"]);
    assert.strictEqual(specs["minimax-m3"].contextWindow, undefined);
    assert.strictEqual(specs["minimax-m3"].maxTokens, undefined);
    assert.strictEqual(specs["minimax-m3"].knowledge, undefined);
    assert.deepStrictEqual(specs["minimax-m3"].inputModalities, ["text"]);
  });

  it("does not leak across providers or on junk payloads", () => {
    assert.deepStrictEqual(
      pickModelsDevSpecs(payload, "opencode-go", ["deepseek/deepseek-v4.1-flash"]),
      {},
    );
    assert.deepStrictEqual(pickModelsDevSpecs(payload, "nope", ["kimi-k3"]), {});
    assert.deepStrictEqual(pickModelsDevSpecs(null, "opencode-go", ["kimi-k3"]), {});
    assert.deepStrictEqual(pickModelsDevSpecs("junk", "opencode-go", ["kimi-k3"]), {});
  });

  it("gates the /mm action on providers whose models.dev key matches the Pi id", () => {
    assert.ok(MODELS_DEV_PROVIDERS.has("opencode-go"));
    assert.ok(MODELS_DEV_PROVIDERS.has("openrouter"));
    assert.ok(!MODELS_DEV_PROVIDERS.has("kimi-coding"));
  });
});

describe("model-manager models.dev modalities -> Pi input", () => {
  // Every row here was cross-checked against Pi's opencode-go catalog.
  it("maps modalities down to what Pi can send", () => {
    assert.deepStrictEqual(toPiInput(["text"]), ["text"]);
    assert.deepStrictEqual(toPiInput(["text", "image"]), ["text", "image"]);
    assert.deepStrictEqual(toPiInput(["text", "image", "video"]), ["text", "image"]);
    assert.deepStrictEqual(toPiInput(["image"]), ["image"]);
  });

  it("returns undefined instead of clobbering on unusable input", () => {
    assert.strictEqual(toPiInput(undefined), undefined);
    assert.strictEqual(toPiInput([]), undefined);
    assert.strictEqual(toPiInput(["video", "pdf"]), undefined);
  });

  it("gives vision to a model the catalog does not know", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      {
        id: "deepseek-v4.1-flash",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
        input: ["text"],
      },
      { contextWindow: 1000000, maxTokens: 384000, input: toPiInput(["text", "image"]) },
    );
    assert.deepStrictEqual(patched.input, ["text", "image"]);
  });

  it("never widens input beyond text/image, whatever the config says", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      { id: "m", api: "openai-completions", input: ["text"] },
      { input: ["video", "pdf", "image"] as never },
    );
    assert.deepStrictEqual(patched.input, ["image"]);
  });

  it("derives input from a pre-existing inputModalities-only override", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      { id: "deepseek-v4.1-flash", api: "openai-completions", input: ["text"] },
      { contextWindow: 1000000, inputModalities: ["text", "image"] },
    );
    assert.deepStrictEqual(patched.input, ["text", "image"]);
  });

  it("leaves input alone when the override has none", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      { id: "m", api: "openai-completions", input: ["text"] },
      { contextWindow: 1000 },
    );
    assert.deepStrictEqual(patched.input, ["text"]);
  });
});

describe("model-manager override wins over the catalog", () => {
  it("fixes the 128k fallback for a model missing from Pi's catalog", () => {
    // What opencodeModelToCached() produces for deepseek-v4.1-flash on Pi 0.84.4.
    const stub = {
      id: "deepseek-v4.1-flash",
      name: "deepseek-v4.1-flash",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 65536,
    };
    const patched = patchCuratedModelDef("opencode-go", stub, {
      contextWindow: 1000000,
      maxTokens: 384000,
    });
    assert.strictEqual(patched.contextWindow, 1000000);
    assert.strictEqual(patched.maxTokens, 384000);
  });

  it("fills the missing cost of a catalog gap so the footer $ appears", () => {
    // Same stub as above: cost 0 today → ui-theme's `if (t.cost > 0)` never fires.
    const stub = {
      id: "deepseek-v4.1-flash",
      api: "openai-completions",
      baseUrl: OPENCODE_GO_BASE_URL,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const patched = patchCuratedModelDef("opencode-go", stub, {
      costInput: 0.15,
      costOutput: 0.6,
      costCacheRead: 0.003,
    });
    assert.strictEqual(patched.cost.input, 0.15);
    assert.strictEqual(patched.cost.output, 0.6);
    assert.strictEqual(patched.cost.cacheRead, 0.003);
    // Stub had no cacheWrite; it stays put rather than becoming undefined.
    assert.strictEqual(patched.cost.cacheWrite, 0);
  });

  it("does not heal deepseek-v4.1-flash any more — Pi 1.0.1 ships it (empty gap table)", () => {
    // The gap table is empty since 1.0.1: the model is catalogued at 0.15/0.6, so
    // an override without `cost*` keeps 0 and the catalog value is what resolve uses.
    const stub = {
      id: "deepseek-v4.1-flash",
      api: "openai-completions",
      baseUrl: OPENCODE_GO_BASE_URL,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 65536,
    };
    const patched = patchCuratedModelDef("opencode-go", stub, {
      contextWindow: 1000000,
      maxTokens: 384000,
    });
    assert.strictEqual(patched.cost.input, 0);
    assert.strictEqual(patched.cost.output, 0);
    assert.strictEqual(patched.contextWindow, 1000000);
  });

  it("does not invent cost for an unknown catalog-gap id", () => {
    const patched = patchCuratedModelDef("opencode-go", {
      id: "brand-new-model",
      api: "openai-completions",
      baseUrl: OPENCODE_GO_BASE_URL,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    assert.strictEqual(patched.cost.input, 0);
    assert.strictEqual(patched.cost.output, 0);
  });

  it("does not overwrite a pulled cost with the gap table", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      {
        id: "deepseek-v4.1-flash",
        api: "openai-completions",
        baseUrl: OPENCODE_GO_BASE_URL,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      { costInput: 9, costOutput: 8, costCacheRead: 1 },
    );
    assert.strictEqual(patched.cost.input, 9);
    assert.strictEqual(patched.cost.output, 8);
    assert.strictEqual(patched.cost.cacheRead, 1);
  });

  it("overrides a catalog value that is present but wrong", () => {
    const catalog = {
      id: "some-model",
      api: "openai-completions",
      baseUrl: OPENCODE_GO_BASE_URL,
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    };
    const patched = patchCuratedModelDef("opencode-go", catalog, {
      contextWindow: 1000000,
      maxTokens: 384000,
      displayName: "Friendly Name",
      costInput: 0.15,
      costOutput: 0.6,
    });
    assert.strictEqual(patched.contextWindow, 1000000);
    assert.strictEqual(patched.maxTokens, 384000);
    assert.strictEqual(patched.name, "Friendly Name");
    assert.strictEqual(patched.cost.input, 0.15);
    assert.strictEqual(patched.cost.output, 0.6);
    // Untouched cost fields survive the merge.
    assert.strictEqual(patched.cost.cacheRead, 0);
  });

  it("keeps the ratio guard when the override itself sets max ≈ ctx", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      { id: "m", api: "openai-completions", baseUrl: OPENCODE_GO_BASE_URL },
      { contextWindow: 262144, maxTokens: 262144 },
    );
    assert.strictEqual(patched.maxTokens, 65536);
  });

  it("does not disturb the Kimi-on-OpenCode profile", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      {
        id: "kimi-k2.7-code",
        api: "openai-completions",
        baseUrl: OPENCODE_GO_BASE_URL,
        contextWindow: 262144,
        maxTokens: 262144,
      },
      { contextWindow: 262144, maxTokens: 65536 },
    );
    assert.strictEqual(patched.compat.thinkingFormat, "deepseek");
    assert.strictEqual(patched.compat.maxTokensField, "max_tokens");
    assert.strictEqual(patched.maxTokens, 65536);
  });

  it("ignores junk override values instead of writing them", () => {
    const patched = patchCuratedModelDef(
      "opencode-go",
      { id: "m", api: "openai-completions", contextWindow: 1000, maxTokens: 100 },
      { contextWindow: 0, maxTokens: -5, displayName: "" },
    );
    assert.strictEqual(patched.contextWindow, 1000);
    assert.strictEqual(patched.maxTokens, 100);
    assert.strictEqual(patched.name, undefined);
  });

  it("applies an override to anthropic-messages models too (no compat touched)", () => {
    const m: Record<string, unknown> = {
      id: "minimax-m3",
      api: "anthropic-messages",
      contextWindow: 1000000,
      maxTokens: 131072,
    };
    assert.strictEqual(patchCuratedModelDef("opencode-go", m), m);
    const patched = patchCuratedModelDef("opencode-go", m, {
      contextWindow: 500000,
      maxTokens: 64000,
    });
    assert.strictEqual(patched.contextWindow, 500000);
    assert.strictEqual(patched.maxTokens, 64000);
    assert.strictEqual(patched.compat, undefined);
    // Original is not mutated.
    assert.strictEqual(m.contextWindow, 1000000);
  });
});
