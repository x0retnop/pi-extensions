import { test } from "node:test";
import assert from "node:assert";

import { formatCallHeader, formatResultLine, incomingSizes, streamSizeHint } from "../../pi-multi-edit/render.js";

const theme = {
  bold: (s: string) => s,
  fg: (_token: string, s: string) => s,
};

test("empty args stay edit ...", () => {
  assert.strictEqual(formatCallHeader("edit", {}, theme), "edit ...");
  assert.strictEqual(streamSizeHint({}), "");
});

test("new_string before path shows growing size, still one line", () => {
  const args = { new_string: "x".repeat(1800) };
  assert.deepStrictEqual(incomingSizes(args), { newLen: 1800, oldLen: 0 });
  assert.strictEqual(streamSizeHint(args), "+1.8k");
  assert.strictEqual(formatCallHeader("edit", args, theme), "edit ... +1.8k");
});

test("old+new before path", () => {
  const args = { new_string: "abc", old_string: "x".repeat(1200) };
  assert.strictEqual(formatCallHeader("edit", args, theme), "edit ... +3 -1.2k");
});

test("path present drops the size hint", () => {
  const args = { path: "C:/proj/a.ts", new_string: "hello", old_string: "bye" };
  assert.strictEqual(streamSizeHint(args), "");
  assert.strictEqual(formatCallHeader("edit", args, theme), "edit C:/proj/a.ts");
});

test("insert and multi_edit follow the same rule", () => {
  assert.strictEqual(formatCallHeader("insert", { new_string: "line\n" }, theme), "insert ... +5");
  assert.strictEqual(
    formatCallHeader("multi_edit", { edits: [{ new_string: "aa" }, { old_string: "bbb" }] }, theme),
    "multi_edit ... (2) +2 -3",
  );
});

test("settled result line carries the file's line delta", () => {
  assert.strictEqual(formatResultLine({ stats: { added: 12, removed: 3 } }, theme), "+12 -3");
  assert.strictEqual(formatResultLine({ stats: { added: 4, removed: 0 } }, theme), "+4");
  assert.strictEqual(formatResultLine({ stats: { added: 0, removed: 2 } }, theme), "-2");
});

test("no stats keeps a placeholder — the body never renders empty", () => {
  assert.strictEqual(formatResultLine(undefined, theme), "done");
  assert.strictEqual(formatResultLine({}, theme), "done");
  assert.strictEqual(formatResultLine({ stats: { added: 0, removed: 0 } }, theme), "done");
});
