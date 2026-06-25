import { test } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { applyEdits } from "../../pi-multi-edit/engine.js";
import { parseEdits, prepareArguments } from "../../pi-multi-edit/params.js";
import type { EditItem, Workspace } from "../../pi-multi-edit/types.js";

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
  const edits: EditItem[] = [{ path: "a.txt", oldText: "hello", newText: "hi" }];
  const results = await applyEdits(edits, ws, cwd);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "hi world");
});

test("batch edit applies multiple changes to one file in order", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "a b c" });
  const edits: EditItem[] = [
    { path: "a.txt", oldText: "a", newText: "x" },
    { path: "a.txt", oldText: "b", newText: "y" },
    { path: "a.txt", oldText: "c", newText: "z" },
  ];
  const results = await applyEdits(edits, ws, cwd);
  assert.strictEqual(results.every((r) => r.success), true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "x y z");
});

test("replaceAll edits all occurrences", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "foo foo foo" });
  const edits: EditItem[] = [{ path: "a.txt", oldText: "foo", newText: "bar", replaceAll: true }];
  const results = await applyEdits(edits, ws, cwd);
  assert.strictEqual(results[0].success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "bar bar bar");
});

test("non-unique oldText fails without replaceAll", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "foo foo" });
  const edits: EditItem[] = [{ path: "a.txt", oldText: "foo", newText: "bar" }];
  await assert.rejects(() => applyEdits(edits, ws, cwd));
});

test("mismatch fails atomically without partialApply", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "abc" });
  const edits: EditItem[] = [
    { path: "a.txt", oldText: "a", newText: "x" },
    { path: "a.txt", oldText: "missing", newText: "y" },
  ];
  await assert.rejects(() => applyEdits(edits, ws, cwd));
  assert.strictEqual(await ws.readText(abs("a.txt")), "abc");
});

test("partialApply applies matching edits and reports failures", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "abc" });
  const edits: EditItem[] = [
    { path: "a.txt", oldText: "a", newText: "x" },
    { path: "a.txt", oldText: "missing", newText: "y" },
  ];
  const results = await applyEdits(edits, ws, cwd, undefined, { continueOnError: true });
  assert.strictEqual(results[0].success, true);
  assert.strictEqual(results[1].success, false);
  assert.strictEqual(await ws.readText(abs("a.txt")), "xbc");
});

test("multi-file batch edits different files", async () => {
  const ws = makeWorkspace({
    [abs("a.txt")]: "aaa",
    [abs("b.txt")]: "bbb",
  });
  const edits: EditItem[] = [
    { path: "a.txt", oldText: "aaa", newText: "AAA" },
    { path: "b.txt", oldText: "bbb", newText: "BBB" },
  ];
  const results = await applyEdits(edits, ws, cwd);
  assert.strictEqual(results.every((r) => r.success), true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "AAA");
  assert.strictEqual(await ws.readText(abs("b.txt")), "BBB");
});

test("prepareArguments normalizes file_path alias to path", () => {
  const prep = prepareArguments({
    file_path: "C:/test/file.txt",
    oldText: "foo",
    newText: "bar",
  });
  assert.strictEqual(prep.path, "C:/test/file.txt");
  assert.strictEqual("file_path" in prep, false);
});

test("prepareArguments normalizes path alias inside edits", () => {
  const prep = prepareArguments({
    edits: [{ filepath: "C:/test/file.txt", oldText: "foo", newText: "bar" }],
  });
  assert.ok(Array.isArray(prep.edits));
  assert.strictEqual(prep.edits?.[0].path, "C:/test/file.txt");
  assert.strictEqual("filepath" in (prep.edits?.[0] ?? {}), false);
});

test("parseEdits accepts file_path alias on top level", () => {
  const parsed = parseEdits({
    file_path: "C:/test/file.txt",
    oldText: "foo",
    newText: "bar",
  });
  assert.strictEqual(parsed.edits.length, 1);
  assert.strictEqual(parsed.edits[0].path, "C:/test/file.txt");
});

test("parseEdits accepts filepath alias inside edits", () => {
  const parsed = parseEdits({
    edits: [{ filepath: "C:/test/file.txt", oldText: "foo", newText: "bar" }],
  });
  assert.strictEqual(parsed.edits.length, 1);
  assert.strictEqual(parsed.edits[0].path, "C:/test/file.txt");
});

test("parseEdits throws clear error for empty top-level path", () => {
  assert.throws(
    () => parseEdits({ path: "", oldText: "foo", newText: "bar" }),
    /Missing path/,
  );
});
