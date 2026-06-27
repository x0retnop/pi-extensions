import { test } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";

import { executeMultiEdit, executeSingleEdit } from "../../pi-multi-edit/engine.js";
import { parseMultiEdit, parseSingleEdit } from "../../pi-multi-edit/params.js";
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

test("multi_edit fails atomically on mismatch", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "abc" });
  await assert.rejects(
    () =>
      executeMultiEdit(
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
      ),
    /Batch edit failed/,
  );
  assert.strictEqual(await ws.readText(abs("a.txt")), "abc");
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
