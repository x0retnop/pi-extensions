import { test } from "node:test";
import assert from "node:assert";
import {
  ANALYTICAL_OUTLINE_OPTIONS,
  extractTextFromContent,
  extractThinkingFromContent,
  extractToolCallsFromContent,
  formatFullToolCallLines,
  formatHistoryOutline,
  renderOutlineEntry,
  runtimeEntriesToOutlineEntries,
  runtimeEntryToOutlineEntry,
  shortToolDescription,
} from "../../common/history-outline.js";

const baseOpts = {
  maxChars: 1000,
  maxToolResultChars: 240,
  includeTimestamps: false,
  includeLegend: false,
  includeThinking: false,
  actionDetail: "short" as const,
  toolResultMode: "summary" as const,
  includeCustom: true,
  maxArgChars: 4000,
};

test("extractTextFromContent returns string as-is", () => {
  assert.strictEqual(extractTextFromContent("hello"), "hello");
});

test("extractTextFromContent joins text blocks", () => {
  const content = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
  assert.strictEqual(extractTextFromContent(content), "a\n\nb");
});

test("extractThinkingFromContent joins thinking blocks", () => {
  const content = [
    { type: "thinking", thinking: "step one" },
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "step two" },
  ];
  assert.strictEqual(extractThinkingFromContent(content), "step one\n\nstep two");
});

test("extractToolCallsFromContent extracts tool calls", () => {
  const content = [
    { type: "toolCall", name: "read", arguments: { path: "x.ts" }, id: "c1" },
    { type: "text", text: "ok" },
  ];
  const calls = extractToolCallsFromContent(content);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "read");
  assert.strictEqual(calls[0].arguments.path, "x.ts");
  assert.strictEqual(calls[0].id, "c1");
});

test("shortToolDescription handles read", () => {
  assert.strictEqual(shortToolDescription("read", { path: "src/foo.ts" }), "read src/foo.ts");
});

test("shortToolDescription handles bash", () => {
  assert.strictEqual(shortToolDescription("bash", { command: "npm run build" }), "bash: npm …");
});

test("shortToolDescription prefers url for fetch_content", () => {
  assert.match(
    shortToolDescription("fetch_content", { max_chars: 100000, url: "https://example.com/a" }),
    /fetch_content https:\/\/example\.com\/a/,
  );
});

test("formatFullToolCallLines emits numbered args", () => {
  const lines = formatFullToolCallLines(
    1,
    {
      name: "bash",
      summary: "bash: ls …",
      args: { command: 'ls -la "/tmp/foo"' },
    },
    4000,
  );
  assert.deepStrictEqual(lines, ["- [1] bash", '  command: ls -la "/tmp/foo"']);
});

test("renderOutlineEntry renders user message", () => {
  const entry = {
    kind: "message" as const,
    role: "user" as const,
    text: "fix bug",
    toolCalls: [],
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, { ...baseOpts });
  assert.match(text, /## User/);
  assert.match(text, /fix bug/);
});

test("renderOutlineEntry renders assistant with short actions", () => {
  const entry = {
    kind: "message" as const,
    role: "assistant" as const,
    text: "checking",
    toolCalls: [{ name: "read", summary: "read src/foo.ts" }],
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, { ...baseOpts });
  assert.match(text, /## Assistant/);
  assert.match(text, /\*\*Actions:\*\*/);
  assert.match(text, /read src\/foo\.ts/);
  assert.doesNotMatch(text, /### Reasoning/);
});

test("renderOutlineEntry silently omits thinking by default", () => {
  const entry = {
    kind: "message" as const,
    role: "assistant" as const,
    text: "done",
    toolCalls: [],
    thinking: "I should be careful",
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, { ...baseOpts });
  assert.match(text, /done/);
  assert.doesNotMatch(text, /I should be careful/);
  assert.doesNotMatch(text, /omitted/i);
  assert.doesNotMatch(text, /### Reasoning/);
});

test("analytical assistant: Reasoning/Reply/Actions full args/Results status", () => {
  const entry = {
    kind: "message" as const,
    role: "assistant" as const,
    text: "final answer",
    toolCalls: [
      { name: "bash", summary: "bash: ls …", args: { command: "ls -la /tmp" } },
      { name: "read", summary: "read a.ts", args: { path: "a.ts" } },
    ],
    thinking: "plan first",
    results: [
      { toolName: "bash", isError: false },
      { toolName: "read", isError: true, errorHint: "ENOENT: missing" },
    ],
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, {
    ...baseOpts,
    includeThinking: true,
    actionDetail: "full",
    toolResultMode: "status",
  });
  assert.match(text, /### Reasoning/);
  assert.match(text, /plan first/);
  assert.match(text, /### Reply/);
  assert.match(text, /final answer/);
  assert.match(text, /### Actions/);
  assert.match(text, /- \[1\] bash/);
  assert.match(text, /command: ls -la \/tmp/);
  assert.match(text, /- \[2\] read/);
  assert.match(text, /path: a\.ts/);
  assert.match(text, /### Results/);
  assert.match(text, /- \[1\] ✅ bash/);
  assert.match(text, /- \[2\] ❌ read — ENOENT: missing/);
  assert.doesNotMatch(text, /file content body/);
});

test("renderOutlineEntry includeThinking keeps thinking-only turns", () => {
  const entry = {
    kind: "message" as const,
    role: "assistant" as const,
    text: "",
    toolCalls: [],
    thinking: "only thinking",
    timestamp: undefined,
  };
  const text = renderOutlineEntry(entry, { ...baseOpts, includeThinking: true });
  assert.match(text, /### Reasoning/);
  assert.match(text, /only thinking/);
  assert.doesNotMatch(text, /### Reply/);
});

test("runtimeEntryToOutlineEntry reads toolName from message", () => {
  const entry = runtimeEntryToOutlineEntry({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "ok line" }],
    },
    timestamp: 1_750_000_000,
  });
  assert.ok(entry);
  assert.strictEqual(entry!.kind, "toolResult");
  if (entry!.kind === "toolResult") {
    assert.strictEqual(entry.toolName, "bash");
    assert.match(entry.summary, /✅ bash/);
  }
});

test("runtimeEntryToOutlineEntry captures assistant thinking and args", () => {
  const entry = runtimeEntryToOutlineEntry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hi" },
        { type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
      ],
    },
  });
  assert.ok(entry);
  assert.strictEqual(entry!.kind, "message");
  if (entry!.kind === "message") {
    assert.strictEqual(entry.thinking, "hmm");
    assert.strictEqual(entry.text, "hi");
    assert.strictEqual(entry.toolCalls[0].args?.command, "echo hi");
  }
});

test("runtimeEntriesToOutlineEntries attaches results to assistant when requested", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "hi" }, timestamp: 1 },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
      },
      timestamp: 2,
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "ENOENT: no such file" }],
      },
      timestamp: 3,
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt\nmore" }],
      },
      timestamp: 4,
    },
  ];
  const outline = runtimeEntriesToOutlineEntries(entries, {
    attachResultsToAssistant: true,
    dropCustom: true,
  });
  assert.strictEqual(outline.length, 2);
  assert.strictEqual(outline[0].kind, "message");
  assert.strictEqual(outline[1].kind, "message");
  if (outline[1].kind === "message") {
    assert.strictEqual(outline[1].toolCalls.length, 2);
    assert.strictEqual(outline[1].results?.length, 2);
    assert.strictEqual(outline[1].results?.[0].toolName, "read");
    assert.strictEqual(outline[1].results?.[0].isError, true);
    assert.match(outline[1].results?.[0].errorHint || "", /ENOENT/);
    assert.strictEqual(outline[1].results?.[1].isError, false);
  }

  const md = formatHistoryOutline(outline, {
    ...ANALYTICAL_OUTLINE_OPTIONS,
    includeThinking: true,
  });
  assert.match(md, /### Actions/);
  assert.match(md, /- \[1\] read/);
  assert.match(md, /path: a\.ts/);
  assert.match(md, /- \[2\] bash/);
  assert.match(md, /command: ls/);
  assert.match(md, /### Results/);
  assert.match(md, /- \[1\] ❌ read — ENOENT/);
  assert.match(md, /- \[2\] ✅ bash/);
  assert.doesNotMatch(md, /file\.txt/);
});

test("runtimeEntriesToOutlineEntries drops custom when dropCustom", () => {
  const entries = [
    { type: "custom", customType: "tool-timestamp", data: { tool: "bash" }, timestamp: 1 },
    { type: "message", message: { role: "user", content: "x" }, timestamp: 2 },
  ];
  const outline = runtimeEntriesToOutlineEntries(entries, { dropCustom: true });
  assert.strictEqual(outline.length, 1);
  assert.strictEqual(outline[0].kind, "message");
});

test("runtimeEntriesToOutlineEntries converts mixed entries without attach", () => {
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
  if (outline[2].kind === "toolResult") {
    assert.strictEqual(outline[2].toolName, "read");
  }
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
