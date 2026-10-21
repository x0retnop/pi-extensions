import assert from "node:assert";
import { describe, it, after } from "node:test";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// root resolves to .tests-out (the file path counts as a segment: ".." three times).
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function pathToFileURL(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (normalized.startsWith("/") ? normalized.slice(1) : normalized);
}

// Isolate from the real ~/.pi/agent (pi-default writes settings.json there).
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "mm-default-test-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const { readPiDefault, writePiDefault } = await import(
  pathToFileURL(path.join(root, "model-manager", "pi-default.js"))
);
const { getDefaultModelForProvider } = await import(
  pathToFileURL(path.join(root, "model-manager", "provider-utils.js"))
);

const settingsPath = path.join(tmpAgent, "settings.json");

after(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  try {
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("pi-default (settings.json startup model)", () => {
  it("returns undefined when no default is stored", () => {
    fs.rmSync(settingsPath, { force: true });
    assert.equal(readPiDefault(), undefined);
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2), "utf-8");
    assert.equal(readPiDefault(), undefined);
  });

  it("writes both keys and keeps every other setting", () => {
    assert.equal(writePiDefault({ provider: "xai", modelId: "grok-4.7" }), true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.defaultProvider, "xai");
    assert.equal(parsed.defaultModel, "grok-4.7");
    assert.equal(parsed.theme, "dark");
    assert.deepEqual(readPiDefault(), { provider: "xai", modelId: "grok-4.7" });
  });

  it("clears both keys on undefined", () => {
    assert.equal(writePiDefault(undefined), true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal("defaultProvider" in parsed, false);
    assert.equal("defaultModel" in parsed, false);
    assert.equal(parsed.theme, "dark");
    assert.equal(readPiDefault(), undefined);
  });

  it("refuses to rewrite a settings.json that does not parse", () => {
    fs.writeFileSync(settingsPath, "{ not json", "utf-8");
    assert.equal(writePiDefault({ provider: "xai", modelId: "grok-4.7" }), false);
    assert.equal(fs.readFileSync(settingsPath, "utf-8"), "{ not json");
  });
});

describe("getDefaultModelForProvider latest pick", () => {
  function ctxWith(ids: string[], provider = "xai") {
    return {
      modelRegistry: { getAll: () => ids.map((id) => ({ id, provider })) },
    } as any;
  }

  it("prefers the highest version number over the lexicographically last id", () => {
    // Plain id descending would pick grok-build-0.1 ("grok-b" > "grok-4").
    const ctx = ctxWith(["grok-4.3", "grok-4.5", "grok-4.6", "grok-4.7", "grok-build-0.1"]);
    assert.equal(getDefaultModelForProvider(ctx, "xai")?.id, "grok-4.7");
  });

  it("still picks the newest within one family", () => {
    const ctx = ctxWith(["deepseek-v4-flash", "deepseek-v4.1-flash"]);
    assert.equal(getDefaultModelForProvider(ctx, "xai")?.id, "deepseek-v4.1-flash");
  });

  it("falls back to dated ids when a provider has no aliases", () => {
    const ctx = ctxWith(["kimi-20250201", "kimi-20260101"]);
    assert.equal(getDefaultModelForProvider(ctx, "xai")?.id, "kimi-20260101");
  });

  it("returns undefined for an unknown provider", () => {
    assert.equal(getDefaultModelForProvider(ctxWith(["grok-4.7"]), "nope"), undefined);
  });
});
