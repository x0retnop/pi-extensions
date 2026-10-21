import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyBom, writeTextPreservingBom } from "../../write-mode/persist.js";

const BOM = "\uFEFF";

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "write-mode-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("applyBom re-adds a BOM only when the file had one", () => {
  assert.strictEqual(applyBom("body", true), `${BOM}body`);
  assert.strictEqual(applyBom("body", false), "body");
  assert.strictEqual(applyBom(`${BOM}body`, true), `${BOM}body`);
  assert.strictEqual(applyBom("", true), BOM);
});

test("a new file is written verbatim, with no BOM", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "new.ts");
    const outcome = await writeTextPreservingBom(target, "let a = 1;\n");

    assert.strictEqual(outcome.oldBytes, null, "no previous file");
    assert.strictEqual(outcome.bomKept, false);
    assert.strictEqual(readFileSync(target, "utf-8"), "let a = 1;\n");
    assert.strictEqual(readFileSync(target).subarray(0, 3).toString("hex"), "6c6574", "no BOM bytes");
  });
});

test("an overwrite keeps the existing BOM and reports the old size", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "Bom.cs");
    const original = `${BOM}using System;\n`;
    writeFileSync(target, original, "utf-8");

    const outcome = await writeTextPreservingBom(target, "using System.Linq;\n");

    assert.strictEqual(outcome.oldBytes, Buffer.byteLength(original, "utf-8"));
    assert.strictEqual(outcome.bomKept, true);
    assert.strictEqual(readFileSync(target).subarray(0, 3).toString("hex"), "efbbbf", "BOM kept");
    assert.strictEqual(readFileSync(target, "utf-8"), `${BOM}using System.Linq;\n`);
  });
});

test("a BOM-less overwrite stays BOM-less, and content may bring its own", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "plain.ts");
    writeFileSync(target, "old\n", "utf-8");

    const first = await writeTextPreservingBom(target, "new\n");
    assert.strictEqual(first.bomKept, false);
    assert.strictEqual(readFileSync(target, "utf-8"), "new\n");

    const second = await writeTextPreservingBom(target, `${BOM}explicit\n`);
    assert.strictEqual(second.bomKept, false, "the model spelled the BOM out itself");
    assert.strictEqual(readFileSync(target, "utf-8"), `${BOM}explicit\n`);
  });
});

test("content is byte-for-byte what the model sent (no line-ending rewriting)", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "crlf.json");
    writeFileSync(target, '{\r\n  "a": 1\r\n}\r\n', "utf-8");

    const content = '{\n  "a": 2\n}\n';
    await writeTextPreservingBom(target, content);

    assert.strictEqual(readFileSync(target, "utf-8"), content, "LF stays LF — the content is the caller's call");
  });
});

test("non-ASCII content round-trips exactly", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "ru.md");
    const content = "Проверка — тире, «кавычки»\n";
    const outcome = await writeTextPreservingBom(target, content);

    assert.strictEqual(readFileSync(target, "utf-8"), content);
    assert.strictEqual(outcome.oldBytes, null);
  });
});

test("a directory target still fails like the native write", async () => {
  await inTempDir(async (dir) => {
    await assert.rejects(() => writeTextPreservingBom(dir, "x"));
  });
});
