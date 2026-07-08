import { test } from "node:test";
import assert from "node:assert";
import {
  extractTextFromContent,
  extractToolCallsFromContent,
  formatHistoryOutline,
  renderOutlineEntry,
  runtimeEntriesToOutlineEntries,
  shortToolDescription,
} from "../../common/history-outline.js";

test("extractTextFromContent returns string as-is", () => {
  assert.strictEqual(extractTextFromContent("hello"), "hello");
});

test("extractTextFromContent joins text blocks", () => {
  const content = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
  assert.strictEqual(extractTextFromContent(content), "a\n\nb");
});

test("extractToolCallsFromContent extracts tool calls", () => {
  const content = [
    { type: "toolCall", name: "read", arguments: { path: "x.ts" } },
    { type: "text", text: "ok" },
  ];
  const calls = extractToolCallsFromContent(content);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "read");
  assert.strictEqual(calls[0].arguments.path, "x.ts");
});

test("shortToolDescription handles read", () => {
  assert.strictEqual(shortToolDescription("read", { path: "src/foo.ts" }), "read src/foo.ts");
});

test("shortToolDescription handles bash", () => {
  assert.strictEqual(shortToolDescription("bash", { command: "npm run build" }), "bash: npm …");
});

test("renderOutlineEntry renders user message", () => {
  const entry = {
    kind: "message" as const,
    role: "user" as const,
    text: "fix bug",
    toolCalls: [],
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, {
    maxChars: 1000,
    maxToolResultChars: 240,
    includeTimestamps: false,
    includeLegend: false,
  });
  assert.match(text, /## User/);
  assert.match(text, /fix bug/);
});

test("renderOutlineEntry renders assistant with actions", () => {
  const entry = {
    kind: "message" as const,
    role: "assistant" as const,
    text: "checking",
    toolCalls: [{ name: "read", summary: "read src/foo.ts" }],
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, {
    maxChars: 1000,
    maxToolResultChars: 240,
    includeTimestamps: false,
    includeLegend: false,
  });
  assert.match(text, /## Assistant/);
  assert.match(text, /Actions:/);
  assert.match(text, /read src\/foo\.ts/);
});

test("runtimeEntriesToOutlineEntries converts mixed entries", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "hi" }, timestamp: 1_750_000_000 },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      timestamp: 1_750_000_001,
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file content" }] },
      timestamp: 1_750_000_002,
    },
  ];
  const outline = runtimeEntriesToOutlineEntries(entries);
  assert.strictEqual(outline.length, 3);
  assert.strictEqual(outline[0].kind, "message");
  assert.strictEqual(outline[1].kind, "message");
  assert.strictEqual(outline[2].kind, "toolResult");
});

test("formatHistoryOutline preserves whole entries under limit", () => {
  const entries = [
    { kind: "message" as const, role: "user" as const, text: "a", toolCalls: [] },
    { kind: "message" as const, role: "assistant" as const, text: "b", toolCalls: [] },
    { kind: "message" as const, role: "user" as const, text: "c", toolCalls: [] },
  ];
  const text = formatHistoryOutline(entries, { maxChars: 10_000, includeTimestamps: false, includeLegend: false });
  assert.match(text, /## User/);
  assert.match(text, /## Assistant/);
  assert.match(text, /a/);
  assert.match(text, /b/);
  assert.match(text, /c/);
});

test("formatHistoryOutline omits intermediate entries when over limit", () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({
    kind: "message" as const,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `m${i}`,
    toolCalls: [],
  }));
  const text = formatHistoryOutline(entries, { maxChars: 800, includeTimestamps: false, includeLegend: false });
  assert.match(text, /intermediate entries omitted/);
  assert.match(text, /## User/);
  assert.match(text, /## Assistant/);
});

test("formatHistoryOutline does not truncate user message text", () => {
  const longText = "x".repeat(10_000);
  const entries = [{ kind: "message" as const, role: "user" as const, text: longText, toolCalls: [] }];
  const text = formatHistoryOutline(entries, { maxChars: 2000, includeTimestamps: false, includeLegend: false });
  assert.ok(!text.includes(longText));
  assert.ok(text.includes("No usable session history") || text.includes("intermediate entries omitted"));
});
