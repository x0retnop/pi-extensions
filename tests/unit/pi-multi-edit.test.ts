import { test } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";

import { executeInsert, executeMultiEdit, executeSingleEdit } from "../../pi-multi-edit/engine.js";
import { parseInsert, parseMultiEdit, parseSingleEdit } from "../../pi-multi-edit/params.js";
import type { Workspace } from "../../pi-multi-edit/types.js";

const cwd = "C:/10x001/project";

function abs(file: string): string {
  return resolve(cwd, file);
}

function makeWorkspace(files: Record<string, string>): Workspace {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    normalized[resolve(k)] = v;
  }
  const state = new Map<string, string>(Object.entries(normalized));
  return {
    readText: async (p) => {
      const key = resolve(p);
      if (!state.has(key)) throw new Error(`File not found: ${p}`);
      return state.get(key)!;
    },
    writeText: async (p, content) => {
      state.set(resolve(p), content);
    },
    checkWriteAccess: async () => {},
  };
}

test("single edit replaces text", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "hello world" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "hello", new_string: "hi" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "hi world");
});

test("single edit delete block", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "hello world" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "hello ", new_string: "" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "world");
});

test("replace_all edits all occurrences", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "foo foo foo" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "foo", new_string: "bar", replace_all: true },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "bar bar bar");
});

test("non-unique old_string fails without replace_all", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "foo foo" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "foo", new_string: "bar" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, false);
  assert.match(result.result.message, /Found 2 occurrences/);
});

test("single edit error includes line number for duplicate", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "line1\nfoo\nfoo" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "foo", new_string: "bar" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, false);
  assert.match(result.result.message, /line 2/);
});

test("single edit fuzzy match is surfaced", async () => {
  // Model sends ASCII quote but file has smart quote.
  const ws = makeWorkspace({ [abs("a.txt")]: "foo ‘bar’ baz" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "'bar'", new_string: "'qux'" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(result.result.usedFuzzy, true);
  assert.match(result.result.message, /fuzzy match/);
});

test("multi_edit applies sequential changes", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "a b c" });
  const result = await executeMultiEdit(
    {
      path: "a.txt",
      edits: [
        { old_string: "a", new_string: "x" },
        { old_string: "b", new_string: "y" },
        { old_string: "c", new_string: "z" },
      ],
    },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.results.every((r) => r.success), true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "x y z");
});

test("multi_edit fails atomically on mismatch and does not write", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "abc" });
  const result = await executeMultiEdit(
    {
      path: "a.txt",
      edits: [
        { old_string: "a", new_string: "x" },
        { old_string: "missing", new_string: "y" },
      ],
    },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.results[0].success, true);
  assert.strictEqual(result.results[1].success, false);
  assert.strictEqual(result.changed, true);
  // Atomic: failed batch should not modify the file.
  assert.strictEqual(await ws.readText(abs("a.txt")), "abc");
});

test("insert prepends at line 1", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "line1\nline2" });
  const result = await executeInsert(
    { path: "a.txt", insert_line: 1, new_string: "header" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(result.result.firstChangedLine, 1);
  assert.strictEqual(await ws.readText(abs("a.txt")), "header\nline1\nline2");
});

test("insert appends at line_count + 1", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "line1\nline2" });
  const result = await executeInsert(
    { path: "a.txt", insert_line: 3, new_string: "footer" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "line1\nline2\nfooter");
});

test("insert rejects out of range line", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "line1\nline2" });
  const result = await executeInsert(
    { path: "a.txt", insert_line: 5, new_string: "x" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, false);
  assert.match(result.result.message, /out of range/);
});

test("parseSingleEdit accepts minimal input", () => {
  const parsed = parseSingleEdit({
    path: "a.txt",
    old_string: "foo",
    new_string: "bar",
  });
  assert.deepStrictEqual(parsed, { path: "a.txt", old_string: "foo", new_string: "bar", replace_all: false });
});

test("parseSingleEdit rejects missing path", () => {
  assert.throws(
    () => parseSingleEdit({ old_string: "foo", new_string: "bar" } as any),
    /Missing path/,
  );
});

test("parseMultiEdit accepts batch", () => {
  const parsed = parseMultiEdit({
    path: "a.txt",
    edits: [
      { old_string: "foo", new_string: "bar" },
      { old_string: "baz", new_string: "qux", replace_all: true },
    ],
  });
  assert.strictEqual(parsed.edits.length, 2);
  assert.strictEqual(parsed.edits[1].replace_all, true);
});

test("parseMultiEdit rejects empty edits", () => {
  assert.throws(
    () => parseMultiEdit({ path: "a.txt", edits: [] } as any),
    /Missing edits/,
  );
});

test("parseMultiEdit rejects more than 4 edits", () => {
  assert.throws(
    () =>
      parseMultiEdit({
        path: "a.txt",
        edits: [
          { old_string: "a", new_string: "1" },
          { old_string: "b", new_string: "2" },
          { old_string: "c", new_string: "3" },
          { old_string: "d", new_string: "4" },
          { old_string: "e", new_string: "5" },
        ],
      } as any),
    /at most 4 edits/,
  );
});

test("multi_edit error includes hint for matched edits", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "alpha beta gamma" });
  const result = await executeMultiEdit(
    {
      path: "a.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "missing", new_string: "X" },
      ],
    },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.results[0].success, true);
  assert.strictEqual(result.results[1].success, false);
  assert.strictEqual(await ws.readText(abs("a.txt")), "alpha beta gamma");
});

test("parseInsert accepts valid input", () => {
  const parsed = parseInsert({ path: "a.txt", insert_line: 5, new_string: "x" });
  assert.deepStrictEqual(parsed, { path: "a.txt", insert_line: 5, new_string: "x" });
});

test("parseInsert rejects missing insert_line", () => {
  assert.throws(
    () => parseInsert({ path: "a.txt", new_string: "x" } as any),
    /Missing insert_line/,
  );
});
