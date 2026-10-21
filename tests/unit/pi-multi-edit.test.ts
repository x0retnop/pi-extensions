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
  assert.match(result.result.message, /Found 2 occurrence\(s\)/);
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
  assert.match(result.result.message, /lines 2, 3/);
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

test("insert result includes context around the insertion point", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "line1\nline2\nline3" });
  const result = await executeInsert(
    { path: "a.txt", insert_line: 3, new_string: "middle" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.match(result.result.message, /Context at insertion point:/);
  // The hint must show the actual post-insert file state, numbered.
  assert.match(result.result.message, /2 \| line2/);
  assert.match(result.result.message, /3 \| middle/);
  assert.match(result.result.message, /4 \| line3/);
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

test("parseMultiEdit accepts more than 4 edits", () => {
  const parsed = parseMultiEdit({
    path: "a.txt",
    edits: [
      { old_string: "a", new_string: "1" },
      { old_string: "b", new_string: "2" },
      { old_string: "c", new_string: "3" },
      { old_string: "d", new_string: "4" },
      { old_string: "e", new_string: "5" },
    ],
  });
  assert.strictEqual(parsed.edits.length, 5);
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

test("parallel edits to the same file do not lose changes", async () => {
  // Regression: two parallel edit calls used to interleave read -> apply ->
  // write, both read the same original and the later full-file write
  // overwrote the earlier one (silent lost edit, both reported success).
  // Delay reads so an unlocked implementation would read stale content.
  const ws = makeWorkspace({ [abs("a.txt")]: "foo bar" });
  const origRead = ws.readText;
  ws.readText = async (p) => {
    const content = await origRead(p);
    await new Promise((r) => setTimeout(r, 10));
    return content;
  };
  const [r1, r2] = await Promise.all([
    executeSingleEdit({ path: "a.txt", old_string: "foo", new_string: "FOO" }, ws, cwd, undefined),
    executeSingleEdit({ path: "a.txt", old_string: "bar", new_string: "BAR" }, ws, cwd, undefined),
  ]);
  assert.strictEqual(r1.result.success, true);
  assert.strictEqual(r2.result.success, true);
  assert.strictEqual(await origRead(abs("a.txt")), "FOO BAR");
});

test("parallel edits to different files stay parallel and both apply", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "foo", [abs("b.txt")]: "bar" });
  const [r1, r2] = await Promise.all([
    executeSingleEdit({ path: "a.txt", old_string: "foo", new_string: "FOO" }, ws, cwd, undefined),
    executeSingleEdit({ path: "b.txt", old_string: "bar", new_string: "BAR" }, ws, cwd, undefined),
  ]);
  assert.strictEqual(r1.result.success, true);
  assert.strictEqual(r2.result.success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "FOO");
  assert.strictEqual(await ws.readText(abs("b.txt")), "BAR");
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

test("single edit preserves CRLF line endings", async () => {
  const ws = makeWorkspace({ [abs("crlf.txt")]: "line1\r\nfoo\r\nline3\r\n" });
  const result = await executeSingleEdit(
    { path: "crlf.txt", old_string: "foo", new_string: "bar" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  const out = await ws.readText(abs("crlf.txt"));
  assert.ok(out.includes("\r\n"), "must keep CRLF");
  assert.ok(!out.replace(/\r\n/g, "").includes("\n") || out.includes("\r\n"));
  assert.strictEqual(out, "line1\r\nbar\r\nline3\r\n");
});

test("single edit preserves UTF-8 BOM", async () => {
  const raw = "\uFEFFhello world";
  const ws = makeWorkspace({ [abs("bom.txt")]: raw });
  const result = await executeSingleEdit(
    { path: "bom.txt", old_string: "hello", new_string: "hi" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  const out = await ws.readText(abs("bom.txt"));
  assert.ok(out.startsWith("\uFEFF"), "BOM must remain");
  assert.strictEqual(out, "\uFEFFhi world");
});

test("empty old_string is rejected", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "hello" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "", new_string: "x" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, false);
  assert.match(result.result.message, /EMPTY|empty/i);
});

test("multi_edit continueOnError writes partial success", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "a b c" });
  const result = await executeMultiEdit(
    {
      path: "a.txt",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "missing", new_string: "X" },
      ],
    },
    ws,
    cwd,
    undefined,
    { continueOnError: true },
  );
  assert.strictEqual(result.results[0].success, true);
  assert.strictEqual(result.results[1].success, false);
  // In-memory batch applies successful steps before failure; with continueOnError the write happens.
  assert.strictEqual(await ws.readText(abs("a.txt")), "A b c");
});

test("identical old/new reports success with no-change warning", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "same" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "same", new_string: "same" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(result.changed, false);
  assert.match(result.result.message, /No change|identical|already/i);
});

test("not-found error includes context hint when possible", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "function authenticate() {\n  return true;\n}\n" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "function autenticate() {", new_string: "function authenticate() {" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, false);
  assert.match(result.result.message, /NOT_FOUND/);
});

test("fuzzy match succeeds when offsets are aligned", async () => {
  const ws = makeWorkspace({ [abs("a.txt")]: "foo\nbar ‘x’ baz" });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "bar 'x'", new_string: "bar 'y'" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(result.result.usedFuzzy, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "foo\nbar 'y' baz");
});

test("fuzzy match with trailing whitespace above fails safely without corrupting the file", async () => {
  // Regression: normalization trims trailing whitespace on earlier lines,
  // which shifted fuzzy indexes vs the original content; an unverified index
  // sliced the wrong span and silently corrupted the file while reporting
  // success. Now the candidate fails verification -> safe NOT_FOUND, file
  // untouched. The agent re-reads and retries with verbatim text, which then
  // exact-matches.
  const original = "foo   \nbar ‘x’ baz";
  const ws = makeWorkspace({ [abs("a.txt")]: original });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "bar 'x'", new_string: "bar 'y'" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, false);
  assert.match(result.result.message, /NOT_FOUND/);
  assert.strictEqual(await ws.readText(abs("a.txt")), original);
});

test("multi_edit reports NOT_FOUND when fuzzy candidate cannot be verified", async () => {
  const original = "foo   \nbar ‘x’ baz";
  const ws = makeWorkspace({ [abs("a.txt")]: original });
  const result = await executeMultiEdit(
    {
      path: "a.txt",
      edits: [{ old_string: "bar 'x'", new_string: "bar 'y'" }],
    },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.results[0].success, false);
  assert.match(result.results[0].message, /NOT_FOUND/);
  assert.strictEqual(await ws.readText(abs("a.txt")), original);
});

test("verbatim retry after a shifted fuzzy failure exact-matches", async () => {
  // The recovery path: after a safe NOT_FOUND the agent copies the text
  // verbatim from a fresh read, which must exact-match despite trailing
  // whitespace elsewhere in the file.
  const original = "foo   \nbar ‘x’ baz";
  const ws = makeWorkspace({ [abs("a.txt")]: original });
  const result = await executeSingleEdit(
    { path: "a.txt", old_string: "bar ‘x’", new_string: "bar ‘y’" },
    ws,
    cwd,
    undefined,
  );
  assert.strictEqual(result.result.success, true);
  assert.strictEqual(await ws.readText(abs("a.txt")), "foo   \nbar ‘y’ baz");
});
