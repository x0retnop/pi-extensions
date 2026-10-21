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
  applyCuratedRegistrations,
  createApplyMemo,
} = await import(pathToFileURL(path.join(root, "model-manager", "provider-utils.js")));

function stubModel(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function customProvider(ids: string[], extra?: { enabled?: boolean }) {
  return {
    id: "my-proxy",
    enabled: extra?.enabled ?? true,
    useLatestDefault: true,
    managedModelIds: ids,
    cachedModels: ids.map(stubModel),
    name: "My Proxy",
    baseUrl: "https://proxy.example.test/v1",
    apiKey: "test-key",
    api: "openai-completions" as const,
  };
}

function mockPi() {
  const calls: string[] = [];
  return {
    calls,
    pi: {
      unregisterProvider: (id: string) => {
        calls.push(`unreg:${id}`);
      },
      registerProvider: (id: string) => {
        calls.push(`reg:${id}`);
      },
    } as any,
    ctx: {
      ui: { notify() {} },
      modelRegistry: {
        getAll: () => [],
        getProviderDisplayName: () => "My Proxy",
        getApiKeyForProvider: async () => "test-key",
      },
    } as any,
  };
}

describe("applyCuratedRegistrations memo", () => {
  it("first apply only registers (no unregister on a fresh runtime)", async () => {
    const { pi, ctx, calls } = mockPi();
    const memo = createApplyMemo();
    await applyCuratedRegistrations(pi, ctx, [customProvider(["m1"])], memo);
    assert.deepEqual(calls, ["reg:my-proxy"]);
    assert.equal(memo.byId.has("my-proxy"), true);
  });

  it("second apply with the same curation is a no-op", async () => {
    const { pi, ctx, calls } = mockPi();
    const memo = createApplyMemo();
    const providers = [customProvider(["m1"])];
    await applyCuratedRegistrations(pi, ctx, providers, memo);
    await applyCuratedRegistrations(pi, ctx, providers, memo);
    assert.deepEqual(calls, ["reg:my-proxy"]);
  });

  it("changed curation unregisters then registers", async () => {
    const { pi, ctx, calls } = mockPi();
    const memo = createApplyMemo();
    await applyCuratedRegistrations(pi, ctx, [customProvider(["m1"])], memo);
    await applyCuratedRegistrations(pi, ctx, [customProvider(["m1", "m2"])], memo);
    assert.deepEqual(calls, ["reg:my-proxy", "unreg:my-proxy", "reg:my-proxy"]);
  });

  it("disabling a previously applied provider unregisters once", async () => {
    const { pi, ctx, calls } = mockPi();
    const memo = createApplyMemo();
    await applyCuratedRegistrations(pi, ctx, [customProvider(["m1"])], memo);
    await applyCuratedRegistrations(pi, ctx, [customProvider([], { enabled: false })], memo);
    assert.deepEqual(calls, ["reg:my-proxy", "unreg:my-proxy"]);
    assert.equal(memo.byId.has("my-proxy"), false);
  });

  it("never-registered empty curation does not unregister", async () => {
    const { pi, ctx, calls } = mockPi();
    await applyCuratedRegistrations(pi, ctx, [customProvider([], { enabled: false })]);
    assert.deepEqual(calls, []);
  });
});
