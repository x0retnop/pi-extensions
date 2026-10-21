import assert from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_MIN_CHARS,
  STUB_MARKER,
  applySupersededReadTrim,
  estimateTrim,
  isFullReadArgs,
  makeStubText,
  normalizePath,
} from "../../context-trim/policy.js";

function assistantReads(
  calls: Array<{ id: string; path: string; args?: Record<string, unknown> }>,
) {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "toolCall",
      id: c.id,
      name: "read",
      arguments: { path: c.path, ...(c.args ?? {}) },
    })),
  };
}

function readResult(id: string, text: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    isError,
    content: [{ type: "text", text }],
  };
}

function editCall(id: string, path: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "edit",
        arguments: { path, old_string: "a", new_string: "b" },
      },
    ],
  };
}

describe("context-trim normalizePath / isFullReadArgs", () => {
  it("normalizes Windows and Git Bash paths", () => {
    assert.strictEqual(normalizePath("C:\\Foo\\bar.ts"), "c:/foo/bar.ts");
    assert.strictEqual(normalizePath("/c/Foo/bar.ts"), "c:/foo/bar.ts");
    assert.strictEqual(normalizePath('"src/a.ts"'), "src/a.ts");
  });

  it("treats raw without window as full", () => {
    assert.strictEqual(isFullReadArgs({ path: "a.ts" }), true);
    assert.strictEqual(isFullReadArgs({ path: "a.ts", mode: "raw" }), true);
  });

  it("rejects overview/section/offset/limit/target", () => {
    assert.strictEqual(isFullReadArgs({ path: "a.ts", mode: "overview" }), false);
    assert.strictEqual(isFullReadArgs({ path: "a.ts", mode: "section", target: "f" }), false);
    assert.strictEqual(isFullReadArgs({ path: "a.ts", offset: 0, limit: 50 }), false);
    assert.strictEqual(isFullReadArgs({ path: "a.ts", limit: 100 }), false);
  });
});

describe("context-trim applySupersededReadTrim", () => {
  it("stubs earlier full read of same path, keeps last", () => {
    const big = "x".repeat(5000);
    const newer = "y".repeat(3000);
    const messages = [
      assistantReads([
        { id: "r1", path: "C:/proj/a.ts" },
        { id: "r2", path: "C:/proj/a.ts" },
      ]),
      readResult("r1", big),
      readResult("r2", newer),
    ];
    const { messages: out, stats, changed } = applySupersededReadTrim(messages, {
      minChars: 2000,
    });
    assert.strictEqual(changed, true);
    assert.strictEqual(stats.stubbed, 1);
    assert.ok(stats.charsSaved > 4000);
    const r1 = out[1];
    const r2 = out[2];
    assert.ok(String(r1.content[0].text).startsWith(STUB_MARKER));
    assert.ok(r1.content[0].text.includes("a.ts") || r1.content[0].text.includes("c:/proj/a.ts"));
    assert.strictEqual(r2.content[0].text, newer);
    assert.strictEqual(r1.toolCallId, "r1");
  });

  it("does not stub when only one full read", () => {
    const messages = [
      assistantReads([{ id: "r1", path: "a.ts" }]),
      readResult("r1", "x".repeat(5000)),
    ];
    const { changed, stats } = applySupersededReadTrim(messages);
    assert.strictEqual(changed, false);
    assert.strictEqual(stats.stubbed, 0);
  });

  it("ignores partial reads (limit) for supersede", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r1",
            name: "read",
            arguments: { path: "a.ts", offset: 1, limit: 50 },
          },
          {
            type: "toolCall",
            id: "r2",
            name: "read",
            arguments: { path: "a.ts" },
          },
        ],
      },
      readResult("r1", "x".repeat(5000)),
      readResult("r2", "y".repeat(5000)),
    ];
    const { changed, stats } = applySupersededReadTrim(messages);
    assert.strictEqual(changed, false);
    assert.strictEqual(stats.stubbed, 0);
  });

  it("does not stub error results", () => {
    const messages = [
      assistantReads([
        { id: "r1", path: "a.ts" },
        { id: "r2", path: "a.ts" },
      ]),
      readResult("r1", "x".repeat(5000), true),
      readResult("r2", "y".repeat(5000)),
    ];
    const { changed } = applySupersededReadTrim(messages);
    assert.strictEqual(changed, false);
  });

  it("skips small results under minChars", () => {
    const messages = [
      assistantReads([
        { id: "r1", path: "a.ts" },
        { id: "r2", path: "a.ts" },
      ]),
      readResult("r1", "small"),
      readResult("r2", "also small but full"),
    ];
    const { changed, stats } = applySupersededReadTrim(messages, { minChars: 2000 });
    assert.strictEqual(changed, false);
    assert.strictEqual(stats.stubbed, 0);
  });

  it("is idempotent: second apply does not change stub text", () => {
    const messages = [
      assistantReads([
        { id: "r1", path: "a.ts" },
        { id: "r2", path: "a.ts" },
      ]),
      readResult("r1", "x".repeat(5000)),
      readResult("r2", "y".repeat(3000)),
    ];
    const first = applySupersededReadTrim(messages);
    assert.strictEqual(first.changed, true);
    const stub1 = first.messages[1].content[0].text;
    const second = applySupersededReadTrim(first.messages);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.messages[1].content[0].text, stub1);
    assert.strictEqual(stub1, makeStubText("a.ts", 5000));
  });

  it("normalizes path aliases to the same key", () => {
    const messages = [
      assistantReads([
        { id: "r1", path: "C:\\proj\\a.ts" },
        { id: "r2", path: "/c/proj/a.ts" },
      ]),
      readResult("r1", "x".repeat(4000)),
      readResult("r2", "y".repeat(4000)),
    ];
    const { stats, changed } = applySupersededReadTrim(messages, { minChars: 2000 });
    assert.strictEqual(changed, true);
    assert.strictEqual(stats.stubbed, 1);
  });

  it("counts write-between when edit sits between reads", () => {
    const messages = [
      assistantReads([{ id: "r1", path: "a.ts" }]),
      readResult("r1", "x".repeat(4000)),
      editCall("e1", "a.ts"),
      { role: "toolResult", toolCallId: "e1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] },
      assistantReads([{ id: "r2", path: "a.ts" }]),
      readResult("r2", "y".repeat(4000)),
    ];
    const { stats, changed } = applySupersededReadTrim(messages);
    assert.strictEqual(changed, true);
    assert.strictEqual(stats.pathsWithWriteBetween, 1);
  });

  it("leaves unrelated paths alone", () => {
    const messages = [
      assistantReads([
        { id: "r1", path: "a.ts" },
        { id: "r2", path: "b.ts" },
        { id: "r3", path: "a.ts" },
      ]),
      readResult("r1", "a1".repeat(2000)),
      readResult("r2", "b".repeat(5000)),
      readResult("r3", "a2".repeat(2000)),
    ];
    const { messages: out, stats } = applySupersededReadTrim(messages, { minChars: 2000 });
    assert.strictEqual(stats.stubbed, 1);
    assert.ok(out[1].content[0].text.startsWith(STUB_MARKER));
    assert.strictEqual(out[2].content[0].text, "b".repeat(5000));
    assert.strictEqual(out[3].content[0].text, "a2".repeat(2000));
  });

  it("estimateTrim matches apply stats", () => {
    const messages = [
      assistantReads([
        { id: "r1", path: "a.ts" },
        { id: "r2", path: "a.ts" },
      ]),
      readResult("r1", "x".repeat(5000)),
      readResult("r2", "y".repeat(3000)),
    ];
    const est = estimateTrim(messages);
    const applied = applySupersededReadTrim(messages);
    assert.strictEqual(est.stubbed, applied.stats.stubbed);
    assert.strictEqual(est.charsSaved, applied.stats.charsSaved);
  });

  it("default minChars is 2000", () => {
    assert.strictEqual(DEFAULT_MIN_CHARS, 2000);
  });
});
