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
  grokFamilyMinor,
  grokThinkCommandStatus,
  grokThinkMatchReason,
  isGrok45PlusId,
  isGrokSummaryModel,
  isXaiGrokTransport,
  shouldHideGrokThinking,
  toGrokThinkRef,
  transformGrokThinkingMarkdown,
  GROK_THINK_HIDDEN_LABEL,
} = await import(pathToFileURL(path.join(root, "model-manager", "grok-think.js")));

describe("grok family id", () => {
  it("reads grok-4.N minor including host display 'grok 4.6 f'", () => {
    assert.strictEqual(grokFamilyMinor("grok-4.5"), 5);
    assert.strictEqual(grokFamilyMinor("grok-4.5-latest"), 5);
    assert.strictEqual(grokFamilyMinor("Grok-4.6"), 6);
    assert.strictEqual(grokFamilyMinor("grok-4.20-multi-agent"), 20);
    assert.strictEqual(grokFamilyMinor("grok 4.6 f"), 6);
    assert.strictEqual(grokFamilyMinor("grok-4.6 f"), 6);
    assert.strictEqual(grokFamilyMinor("Grok 4.6 f"), 6);
    assert.strictEqual(grokFamilyMinor("grok-4.3"), 3);
    assert.strictEqual(grokFamilyMinor("grok-build-0.1"), null);
    assert.strictEqual(grokFamilyMinor("grok-3"), null);
    assert.strictEqual(grokFamilyMinor("kimi-k2.7-code"), null);
    assert.ok(isGrok45PlusId("grok-4.5"));
    assert.ok(isGrok45PlusId("grok-4.6"));
    assert.ok(isGrok45PlusId("grok 4.6 f"));
    assert.ok(!isGrok45PlusId("grok-4.3"));
    assert.ok(!isGrok45PlusId("grok-4.6f"));
  });
});

describe("xAI transport", () => {
  it("accepts xai / known proxies / xAI baseUrl, rejects other hops", () => {
    assert.ok(isXaiGrokTransport("xai"));
    assert.ok(isXaiGrokTransport("XAI"));
    assert.ok(isXaiGrokTransport("opencode"));
    assert.ok(isXaiGrokTransport("opencode-go"));
    assert.ok(isXaiGrokTransport("my-xai", "https://api.x.ai/v1"));
    assert.ok(isXaiGrokTransport("custom", "https://cli-chat-proxy.grok.com/v1"));
    assert.ok(!isXaiGrokTransport("openrouter"));
    assert.ok(!isXaiGrokTransport("openrouter", "https://openrouter.ai/api/v1"));
    assert.ok(!isXaiGrokTransport("anthropic"));
  });
});

describe("summary-model AND", () => {
  it("needs both grok-4.5+ id and xAI transport", () => {
    assert.ok(isGrokSummaryModel({ provider: "xai", id: "grok-4.6" }));
    assert.ok(isGrokSummaryModel({ provider: "xai", id: "grok-4.6", name: "grok 4.6 f" }));
    assert.ok(isGrokSummaryModel({ provider: "xai", id: "unused", name: "grok 4.6 f" }));
    assert.ok(isGrokSummaryModel({ provider: "xai", id: "grok-4.5" }));
    assert.ok(isGrokSummaryModel({ provider: "opencode", id: "grok-4.6" }));
    assert.ok(isGrokSummaryModel({ provider: "custom", id: "grok-4.6", baseUrl: "https://api.x.ai/v1" }));
    assert.ok(!isGrokSummaryModel({ provider: "xai", id: "grok-4.3" }));
    assert.ok(!isGrokSummaryModel({ provider: "xai", id: "grok-build-0.1" }));
    assert.ok(!isGrokSummaryModel({ provider: "openrouter", id: "grok-4.6" }));
    assert.ok(!isGrokSummaryModel({ provider: "xai", id: "kimi-k2.7-code" }));
    assert.ok(!isGrokSummaryModel(undefined));
    assert.ok(!isGrokSummaryModel(toGrokThinkRef({ name: "grok 4.6 f" })));
  });
});

describe("hide decision / transformer", () => {
  const grok = { provider: "xai", id: "grok-4.6" };
  const kimi = { provider: "kimi-coding", id: "kimi-k2.7-code" };

  it("hides only assistant-thinking when enabled and matched", () => {
    assert.ok(shouldHideGrokThinking(grok, true));
    assert.ok(!shouldHideGrokThinking(grok, false));
    assert.ok(!shouldHideGrokThinking(kimi, true));
    assert.strictEqual(
      transformGrokThinkingMarkdown("Let me explore the repo.", "assistant-thinking", grok, true),
      GROK_THINK_HIDDEN_LABEL,
    );
    assert.strictEqual(
      transformGrokThinkingMarkdown("Let me explore the repo.", "assistant-thinking", grok, false),
      "Let me explore the repo.",
    );
    assert.strictEqual(
      transformGrokThinkingMarkdown("Сначала сниму карту.", "assistant", grok, true),
      "Сначала сниму карту.",
    );
    assert.strictEqual(
      transformGrokThinkingMarkdown("Let me explore the repo.", "assistant-thinking", kimi, true),
      "Let me explore the repo.",
    );
  });

  it("status line names the match reason", () => {
    const hidden = grokThinkCommandStatus(true, grok);
    assert.match(hidden, /hidden \(active\)/);
    assert.match(hidden, /xai::grok-4\.6/);
    assert.match(grokThinkCommandStatus(true, kimi), /idle/);
    assert.match(grokThinkMatchReason({ provider: "xai", id: "grok-4.3" }), /no encrypted-summary/);
    assert.match(grokThinkMatchReason({ provider: "openrouter", id: "grok-4.6" }), /transport is not xAI/);
  });
});
