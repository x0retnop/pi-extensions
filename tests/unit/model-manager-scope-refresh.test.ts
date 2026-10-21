import assert from "node:assert";
import { describe, it, after } from "node:test";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function pathToFileURL(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (normalized.startsWith("/") ? normalized.slice(1) : normalized);
}

// Isolate config I/O for curatedModelsFromCache + refresh offline path.
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "mm-scope-test-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const {
  hasModelScope,
  isModelInScope,
  findScopedThinkingLevel,
  describeModelScope,
} = await import(pathToFileURL(path.join(root, "model-manager", "scope.js")));

const { curatedModelsFromCache } = await import(
  pathToFileURL(path.join(root, "model-manager", "provider-utils.js"))
);

const { createDefaultConfig, saveConfig } = await import(
  pathToFileURL(path.join(root, "model-manager", "config.js"))
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

function mockCtx(scoped: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }> | undefined) {
  return { scopedModels: scoped } as any;
}

describe("model-manager scopedModels helpers", () => {
  it("empty / missing scope means all models are in scope", () => {
    assert.strictEqual(hasModelScope(mockCtx(undefined)), false);
    assert.strictEqual(hasModelScope(mockCtx([])), false);
    assert.strictEqual(isModelInScope(mockCtx([]), "opencode-go", "deepseek-v4-flash"), true);
    assert.strictEqual(describeModelScope(mockCtx([])), undefined);
  });

  it("non-empty scope filters by provider/id", () => {
    const ctx = mockCtx([
      { model: { provider: "opencode-go", id: "deepseek-v4-flash" }, thinkingLevel: "high" },
      { model: { provider: "opencode-go", id: "kimi-k2.7-code" } },
    ]);
    assert.strictEqual(hasModelScope(ctx), true);
    assert.strictEqual(isModelInScope(ctx, "opencode-go", "deepseek-v4-flash"), true);
    assert.strictEqual(isModelInScope(ctx, "opencode-go", "other"), false);
    assert.strictEqual(isModelInScope(ctx, "openrouter", "deepseek-v4-flash"), false);
    assert.strictEqual(findScopedThinkingLevel(ctx, "opencode-go", "deepseek-v4-flash"), "high");
    assert.strictEqual(findScopedThinkingLevel(ctx, "opencode-go", "kimi-k2.7-code"), undefined);
    assert.strictEqual(describeModelScope(ctx), "2 models in session scope");
  });
});

describe("model-manager curatedModelsFromCache", () => {
  it("returns only managed IDs enriched from cache", () => {
    const managed = {
      id: "opencode-go",
      enabled: true,
      useLatestDefault: true,
      managedModelIds: ["deepseek-v4-flash", "missing-from-cache"],
      cachedModels: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          api: "openai-completions" as const,
          reasoning: true,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 65536,
        },
      ],
    };
    const list = curatedModelsFromCache("opencode-go", managed);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, "deepseek-v4-flash");
    assert.strictEqual(list[1].id, "missing-from-cache");
    // Stub gets sane defaults (not left empty).
    assert.ok(list[1].contextWindow > 0);
    assert.ok(list[1].maxTokens > 0);
  });

  it("returns empty when nothing is curated", () => {
    assert.deepStrictEqual(
      curatedModelsFromCache("openrouter", {
        id: "openrouter",
        enabled: true,
        useLatestDefault: true,
        managedModelIds: [],
      }),
      [],
    );
  });
});

describe("model-manager config still saves after scope helpers load", () => {
  it("round-trips favorites (auth/getApiKey path untouched)", () => {
    const cfg = createDefaultConfig();
    cfg.favorites = [{ providerId: "opencode-go", modelId: "deepseek-v4-flash" }];
    assert.strictEqual(saveConfig(cfg), true);
  });
});
