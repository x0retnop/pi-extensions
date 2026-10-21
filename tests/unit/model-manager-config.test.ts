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
const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "mm-config-test-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const { createDefaultConfig, loadConfig, saveConfig, getConfigPath } = await import(
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

describe("model-manager config save/load", () => {
  it("saveConfig returns true and round-trips settings", () => {
    const cfg = createDefaultConfig();
    cfg.favorites = [{ providerId: "opencode-go", modelId: "kimi-k2.7-code" }];
    cfg.global.displaySpecs = false;
    cfg.global.rememberLastUsed = false;

    assert.strictEqual(saveConfig(cfg), true);
    assert.ok(fs.existsSync(getConfigPath()));

    const loaded = loadConfig();
    assert.strictEqual(loaded.global.displaySpecs, false);
    assert.strictEqual(loaded.global.rememberLastUsed, false);
    assert.strictEqual(loaded.global.hideGrokThinking, true);
    assert.deepStrictEqual(loaded.favorites, cfg.favorites);
  });

  it("hideGrokThinking defaults on and persists explicit off", () => {
    const fresh = createDefaultConfig();
    assert.strictEqual(fresh.global.hideGrokThinking, true);
    fresh.global.hideGrokThinking = false;
    assert.strictEqual(saveConfig(fresh), true);
    assert.strictEqual(loadConfig().global.hideGrokThinking, false);
  it("missing hideGrokThinking in old json loads as true", () => {
    const raw = createDefaultConfig();
    delete (raw.global as { hideGrokThinking?: boolean }).hideGrokThinking;
    fs.writeFileSync(getConfigPath(), JSON.stringify(raw), "utf-8");
    assert.strictEqual(loadConfig().global.hideGrokThinking, true);
  });

  });

  it("saveConfig returns false when agent dir cannot be created", () => {
    // Point agent dir at a path whose parent is a file → mkdir fails.
    const blocker = path.join(tmpAgent, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf-8");
    const badDir = path.join(blocker, "agent");
    process.env.PI_CODING_AGENT_DIR = badDir;
    try {
      const ok = saveConfig(createDefaultConfig());
      assert.strictEqual(ok, false);
    } finally {
      process.env.PI_CODING_AGENT_DIR = tmpAgent;
      fs.unlinkSync(blocker);
    }
  });
});
