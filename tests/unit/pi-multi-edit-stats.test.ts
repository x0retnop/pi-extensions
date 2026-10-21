import { test } from "node:test";
import assert from "node:assert";

import { computeChangeStats } from "../../pi-multi-edit/diff.js";

function lines(count: number, prefix = "line"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

test("rewriting a line counts as one add and one remove", () => {
  const before = lines(10);
  const after = before.slice();
  after[4] = "line 5 changed and much longer";
  assert.deepStrictEqual(computeChangeStats(before.join("\n"), after.join("\n")), {
    added: 1,
    removed: 1,
  });
});

test("inserted block is pure additions", () => {
  const before = lines(10);
  const after = [...before.slice(0, 3), "new a", "new b", "new c", "new d", ...before.slice(3)];
  assert.deepStrictEqual(computeChangeStats(before.join("\n"), after.join("\n")), {
    added: 4,
    removed: 0,
  });
});

test("deleted block is pure removals", () => {
  const before = lines(10);
  const after = before.filter((_, i) => i < 2 || i > 4);
  assert.deepStrictEqual(computeChangeStats(before.join("\n"), after.join("\n")), {
    added: 0,
    removed: 3,
  });
});

test("block replacement reports both sides", () => {
  const before = lines(10);
  const after = [...before.slice(0, 2), "x1", "x2", "x3", ...before.slice(4)];
  assert.deepStrictEqual(computeChangeStats(before.join("\n"), after.join("\n")), {
    added: 3,
    removed: 2,
  });
});

test("identical content is 0/0", () => {
  const text = lines(20).join("\n");
  assert.deepStrictEqual(computeChangeStats(text, text), { added: 0, removed: 0 });
});

test("only the changed region reaches the DP: 5000-line file, 40 lines -> 55", () => {
  const before = lines(5000);
  const after = [
    ...before.slice(0, 2000),
    ...lines(55, "new"),
    ...before.slice(2040),
  ];
  assert.deepStrictEqual(computeChangeStats(before.join("\n"), after.join("\n")), {
    added: 55,
    removed: 40,
  });
});

test("large file, single-line rewrite is not collapsed to 0/0", () => {
  const before = lines(900);
  const after = before.slice();
  after[450] = "changed";
  assert.deepStrictEqual(computeChangeStats(before.join("\n"), after.join("\n")), {
    added: 1,
    removed: 1,
  });
});

test("CRLF content is counted per line", () => {
  assert.deepStrictEqual(computeChangeStats("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"), {
    added: 1,
    removed: 1,
  });
});
