import assert from "node:assert";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function pathToFileURL(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (normalized.startsWith("/") ? normalized.slice(1) : normalized);
}

const {
  patchCuratedModelDef,
  detectModelFamily,
  sanitizeMaxTokens,
  KIMI_OPENCODE_WIRE,
  OPENCODE_GO_BASE_URL,
  OPENROUTER_BASE_URL,
} = await import(pathToFileURL(path.join(root, "model-manager", "wire-compat.js")));

describe("model-manager wire-compat family detection", () => {
  it("detects kimi / moonshot / deepseek / reasoner", () => {
    assert.strictEqual(detectModelFamily("kimi-k2.7-code"), "kimi");
    assert.strictEqual(detectModelFamily("moonshotai/kimi-k2.6"), "kimi");
    assert.strictEqual(detectModelFamily("deepseek-v4-flash"), "deepseek");
    assert.strictEqual(detectModelFamily("foo-r1-bar"), "reasoner");
    assert.strictEqual(detectModelFamily("gpt-4o"), "other");
  });
});

describe("model-manager wire-compat sanitizeMaxTokens", () => {
  it("caps when maxTokens ≈ contextWindow", () => {
    assert.strictEqual(sanitizeMaxTokens({ maxTokens: 262144, contextWindow: 262144 }), 65536);
  });

  it("leaves healthy ratios alone", () => {
    assert.strictEqual(sanitizeMaxTokens({ maxTokens: 65536, contextWindow: 262144 }), 65536);
  });
});

describe("model-manager wire-compat profiles", () => {
  it("applies Kimi-on-OpenCode profile to stock kimi-k2.7-code", () => {
    // Exact Pi catalog entry (broken for multi-turn and maxTokens headroom).
    const stock = {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      api: "openai-completions",
      baseUrl: OPENCODE_GO_BASE_URL,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
      },
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 262144,
    };
    const patched = patchCuratedModelDef("opencode-go", stock);

    assert.strictEqual(patched.compat.thinkingFormat, KIMI_OPENCODE_WIRE.thinkingFormat);
    assert.strictEqual(patched.compat.supportsReasoningEffort, false);
    assert.strictEqual(patched.compat.requiresReasoningContentOnAssistantMessages, true);
    assert.strictEqual(patched.compat.maxTokensField, "max_tokens");
    assert.strictEqual(patched.maxTokens, 65536);
    assert.ok(patched.thinkingLevelMap);
    assert.strictEqual(patched.thinkingLevelMap.medium, null);
  });

  it("does not force OpenCode Kimi profile on OpenRouter", () => {
    const stock = {
      id: "moonshotai/kimi-k2.7-code",
      api: "openai-completions",
      baseUrl: OPENROUTER_BASE_URL,
      compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 262144,
    };
    const patched = patchCuratedModelDef("openrouter", stock);
    assert.strictEqual(patched.compat.thinkingFormat, "openrouter");
    assert.strictEqual(patched.compat.requiresReasoningContentOnAssistantMessages, true);
    assert.strictEqual(patched.maxTokens, 65536);
    // No forced deepseek format on OpenRouter
    assert.notStrictEqual(patched.compat.supportsReasoningEffort, false);
  });

  it("leaves deepseek catalog wire intact aside from maxTokens rules", () => {
    const deepseek = {
      id: "deepseek-v4-flash",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 384000,
      compat: {
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
        maxTokensField: "max_tokens",
      },
    };
    const patched = patchCuratedModelDef("opencode-go", deepseek);
    assert.strictEqual(patched.compat.thinkingFormat, "deepseek");
    assert.strictEqual(patched.compat.requiresReasoningContentOnAssistantMessages, true);
    assert.strictEqual(patched.maxTokens, 384000);
  });

  it("does not touch prompt-cache retention any more", () => {
    // The host dropped PI_CACHE_RETENTION (2026-09-25); wire-compat stays out of
    // the retention flags so nothing here can go stale. Kimi keeps its explicit
    // wire (KIMI_OPENCODE_WIRE) — that one is about the k2.6 shape, not caching.
    const stock = {
      id: "deepseek-v4.1-flash",
      api: "openai-completions",
      baseUrl: OPENCODE_GO_BASE_URL,
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 131072,
      compat: {},
    };
    const patched = patchCuratedModelDef("opencode-go", stock);
    assert.strictEqual("supportsLongCacheRetention" in patched.compat, false);
  });

  it("skips anthropic-messages models", () => {
    const m: Record<string, unknown> = {
      id: "minimax-m3",
      api: "anthropic-messages",
      reasoning: true,
    };
    assert.strictEqual(patchCuratedModelDef("opencode-go", m), m);
  });
});
