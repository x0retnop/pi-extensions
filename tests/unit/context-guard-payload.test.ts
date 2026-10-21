import { test } from "node:test";
import assert from "node:assert";
import {
  extractSystemPromptFromPayload,
  mapSystemPromptInPayload,
} from "../../context-guard/payload.js";
import { pickDumpSystemPrompt } from "../../context-guard/dump.js";

const ROLE = "## Role\nDo the work.";

function roundTrip(payload: unknown, label: string): void {
  assert.strictEqual(extractSystemPromptFromPayload(payload), ROLE, `${label}: extract`);
  const mapped = mapSystemPromptInPayload(payload, (t) => t.replace("Do the work.", "DONE"));
  assert.ok(mapped, `${label}: map returned a payload`);
  assert.strictEqual(
    extractSystemPromptFromPayload(mapped),
    "## Role\nDONE",
    `${label}: mapped extract`,
  );
  assert.strictEqual(
    mapSystemPromptInPayload(payload, (t) => t),
    undefined,
    `${label}: unchanged map is undefined`,
  );
}

test("payload: Anthropic top-level system string", () => {
  roundTrip({ model: "claude", system: ROLE, messages: [] }, "anthropic-string");
});

test("payload: Anthropic / Bedrock system blocks + cache_control kept", () => {
  const payload = {
    system: [{ type: "text", text: ROLE, cache_control: { type: "ephemeral" } }],
    messages: [],
  };
  roundTrip(payload, "anthropic-blocks");
  const mapped = mapSystemPromptInPayload(payload, (t) => t.replace("Do the work.", "DONE")) as any;
  assert.deepStrictEqual(mapped.system[0].cache_control, { type: "ephemeral" });
});

test("payload: OpenAI Completions messages role=system", () => {
  roundTrip(
    { messages: [{ role: "system", content: ROLE }, { role: "user", content: "hi" }] },
    "completions-system",
  );
});

test("payload: OpenAI Completions messages role=developer", () => {
  roundTrip(
    { messages: [{ role: "developer", content: ROLE }, { role: "user", content: "hi" }] },
    "completions-developer",
  );
});

test("payload: openai-responses input[] role=developer (Grok)", () => {
  roundTrip(
    {
      model: "grok-4.6",
      input: [{ role: "developer", content: ROLE }, { role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    },
    "responses-developer",
  );
});

test("payload: openai-responses input[] role=system with input_text blocks", () => {
  roundTrip(
    { input: [{ role: "system", content: [{ type: "input_text", text: ROLE }] }] },
    "responses-blocks",
  );
});

test("payload: openai-codex-responses instructions", () => {
  roundTrip(
    { instructions: ROLE, input: [{ role: "user", content: "hi" }] },
    "codex-instructions",
  );
});

test("payload: Google systemInstruction string", () => {
  roundTrip({ systemInstruction: ROLE, contents: [] }, "google-string");
});

test("payload: Google systemInstruction parts", () => {
  roundTrip({ systemInstruction: { parts: [{ text: ROLE }] } }, "google-parts");
});

test("payload: unrecognized shape returns undefined (does not throw)", () => {
  const odd = { model: "grok-4.6", input: [{ role: "user", content: "hi" }], stream: true };
  assert.strictEqual(extractSystemPromptFromPayload(odd), undefined);
  assert.strictEqual(mapSystemPromptInPayload(odd, (t) => t + "!"), undefined);
  assert.strictEqual(extractSystemPromptFromPayload(null), undefined);
  assert.strictEqual(extractSystemPromptFromPayload("x"), undefined);
});

test("pickDumpSystemPrompt: extracted final wins", () => {
  const r = pickDumpSystemPrompt({
    finalSystemPrompt: "FINAL",
    baseSystemPrompt: "BASE",
    sessionSystemPrompt: "SESSION",
    hadProviderPayload: true,
  });
  assert.deepStrictEqual(r, { prompt: "FINAL", isPreTurn: false, extractFailed: false });
});

test("pickDumpSystemPrompt: payload present but extract failed → session, not base, not pre-turn", () => {
  const r = pickDumpSystemPrompt({
    baseSystemPrompt: "BASE canary",
    sessionSystemPrompt: "SESSION with role",
    hadProviderPayload: true,
  });
  assert.deepStrictEqual(r, {
    prompt: "SESSION with role",
    isPreTurn: false,
    extractFailed: true,
  });
});

test("pickDumpSystemPrompt: no provider request → pre-turn base", () => {
  const r = pickDumpSystemPrompt({
    baseSystemPrompt: "BASE",
    sessionSystemPrompt: "SESSION",
    hadProviderPayload: false,
  });
  assert.deepStrictEqual(r, { prompt: "BASE", isPreTurn: true, extractFailed: false });
});
