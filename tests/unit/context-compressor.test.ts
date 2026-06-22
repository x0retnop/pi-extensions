import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings } from "../../context-compressor/config.js";
import { DEFAULT_SETTINGS } from "../../context-compressor/types.js";
import {
  extractKeyFacts,
  fitTranscript,
  injectKeyFacts,
  loadPrompt,
  resolvePromptName,
  trimMessages,
} from "../../context-compressor/compressor.js";

const SETTINGS_KEY = "contextCompressor";

function withTempSettings<T>(value: unknown, fn: () => T): T {
  const realPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let backup: Buffer | null = null;
  if (fs.existsSync(realPath)) {
    backup = fs.readFileSync(realPath);
  }
  try {
    fs.mkdirSync(path.dirname(realPath), { recursive: true });
    fs.writeFileSync(realPath, JSON.stringify({ [SETTINGS_KEY]: value }, null, 2));
    return fn();
  } finally {
    if (backup) {
      fs.writeFileSync(realPath, backup);
    } else {
      try {
        fs.unlinkSync(realPath);
      } catch {
        // ignore
      }
    }
  }
}

test("loadSettings returns defaults when settings file is missing", () => {
  const settings = withTempSettings(undefined, () => loadSettings());
  assert.equal(settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(settings.promptName, DEFAULT_SETTINGS.promptName);
  assert.equal(settings.mode, DEFAULT_SETTINGS.mode);
});

test("loadSettings clamps invalid numbers", () => {
  const settings = withTempSettings(
    {
      tokenThresholdPercent: 5,
      stepInterval: -1,
      maxSummaryTokens: 90000,
    },
    () => loadSettings(),
  );
  assert.equal(settings.tokenThresholdPercent, 10);
  assert.equal(settings.stepInterval, 1);
  assert.equal(settings.maxSummaryTokens, 8000);
});

test("saveSettings persists values", () => {
  const next = { ...loadSettings(), enabled: false, mode: "manual" as const };
  withTempSettings(next, () => {
    saveSettings(next);
    const loaded = loadSettings();
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.mode, "manual");
  });
});

test("loadPrompt returns null for missing prompt", () => {
  assert.equal(loadPrompt("definitely-missing"), null);
});

test("resolvePromptName keeps configured name when no prompts are available", () => {
  assert.equal(resolvePromptName({ ...DEFAULT_SETTINGS, promptName: "balanced" }), "balanced");
});

test("fitTranscript returns short transcript unchanged", () => {
  const transcript = "Short history.";
  assert.equal(fitTranscript(transcript, 128000, 2000), transcript);
});

test("fitTranscript truncates long transcript from the start", () => {
  const transcript = "A".repeat(1_000_000);
  const fitted = fitTranscript(transcript, 128000, 2000);
  assert.ok(fitted.length < transcript.length);
  assert.ok(fitted.includes("truncated"));
  assert.ok(fitted.endsWith("A"));
});

test("extractKeyFacts pulls block from marker", () => {
  const raw = "Some intro\n\n**KEY FACTS**\n\n- Goal: x\n- File: y";
  const facts = extractKeyFacts(raw);
  assert.ok(facts);
  assert.ok(facts!.startsWith("**KEY FACTS**"));
  assert.ok(facts!.includes("Goal: x"));
});

test("extractKeyFacts wraps unmarked structured output", () => {
  const raw = "- Goal: x\n- File: y";
  const facts = extractKeyFacts(raw);
  assert.ok(facts);
  assert.ok(facts!.startsWith("**KEY FACTS**"));
});

test("extractKeyFacts rejects plain prose without markers or bullets", () => {
  assert.equal(extractKeyFacts("Just some plain text here"), null);
});

test("injectKeyFacts returns original messages when no keyFacts", () => {
  const messages = [{ role: "user", content: "hi" }];
  const result = injectKeyFacts(messages, { keyFacts: null } as any);
  assert.strictEqual(result, messages);
});

test("injectKeyFacts prepends custom message", () => {
  const messages = [{ role: "user", content: "hi" }];
  const result = injectKeyFacts(messages, { keyFacts: "Goal: x" } as any);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, "custom");
  assert.equal(result[0].customType, "context-compressor");
  assert.ok(result[0].content.includes("Goal: x"));
});

test("trimMessages keeps last N messages", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: String(i) }));
  const result = trimMessages(messages, 4);
  assert.equal(result.length, 4);
  assert.equal(result[0].content, "6");
});
