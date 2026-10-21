import { test } from "node:test";
import assert from "node:assert";

import {
  contentStats,
  fmtSize,
  formatWriteHeader,
  formatWriteResult,
  matchRecentPath,
  shortenPath,
  syncWriteTimer,
  type WriteRowState,
} from "../../write-mode/render.js";

const theme = {
  bold: (s: string) => s,
  fg: (_token: string, s: string) => s,
};

test("empty args: write ... and no stats", () => {
  assert.strictEqual(formatWriteHeader({}, theme), "write ...");
});

test("content before path: counts grow, header stays one line", () => {
  assert.deepStrictEqual(contentStats({ content: "x".repeat(1800) }), { chars: 1800, lines: 1 });
  assert.strictEqual(formatWriteHeader({ content: "x".repeat(1800) }, theme), "write ... +1.8k, 1 line");
  assert.strictEqual(formatWriteHeader({ content: "a\n".repeat(96) }, theme), "write ... +192, 96 lines");
});

test("streaming with a live timer", () => {
  assert.strictEqual(
    formatWriteHeader({ path: "C:/p/a.ts", content: "hi" }, theme, { elapsedMs: 4000 }),
    "write C:/p/a.ts +2, 1 line · 4s",
  );
  assert.strictEqual(formatWriteHeader({}, theme, { elapsedMs: 400 }), "write ... · 0.4s");
});

test("settled: chars and lines", () => {
  assert.strictEqual(
    formatWriteHeader({ path: "C:/p/a.ts", content: "x".repeat(2400) }, theme, { settled: true }),
    "write C:/p/a.ts 2.4k, 1 line",
  );
  assert.strictEqual(
    formatWriteHeader({ path: "C:/p/a.ts", content: "a\n".repeat(96) }, theme, { settled: true }),
    "write C:/p/a.ts 192, 96 lines",
  );
});

test("settled overwrite shows the pre-write size", () => {
  assert.strictEqual(
    formatWriteHeader({ path: "C:/p/a.ts", content: "x".repeat(2400) }, theme, {
      settled: true,
      oldBytes: 1100,
    }),
    "write C:/p/a.ts 1.1k → 2.4k, 1 line",
  );
  assert.strictEqual(
    formatWriteHeader({ path: "C:/p/a.ts", content: "" }, theme, { settled: true, oldBytes: 1100 }),
    "write C:/p/a.ts 1.1k → empty",
  );
});

test("trailing newline is not a line", () => {
  assert.deepStrictEqual(contentStats({ content: "a\nb" }), { chars: 3, lines: 2 });
  assert.deepStrictEqual(contentStats({ content: "a\n" }), { chars: 2, lines: 1 });
  assert.deepStrictEqual(contentStats({}), { chars: 0, lines: 0 });
});

test("model-facing result: size, lines, and new vs overwrite", () => {
  assert.strictEqual(
    formatWriteResult("src/app.ts", "x".repeat(2400), null),
    "Wrote src/app.ts — 2.4k chars, 1 line (new file)",
  );
  assert.strictEqual(
    formatWriteResult("src/app.ts", "a\n".repeat(96), 1100),
    "Wrote src/app.ts — 192 chars, 96 lines (overwrote 1.1k)",
  );
  assert.strictEqual(
    formatWriteResult("src/app.ts", "", null),
    "Wrote src/app.ts — 0 chars, 0 lines (new file)",
  );
  // Path is echoed as the model wrote it — the executed args are authoritative, not the file system.
  assert.strictEqual(
    formatWriteResult("C:/p/a.ts", "hi", 0),
    "Wrote C:/p/a.ts — 2 chars, 1 line (overwrote 0)",
  );
});

test("fmtSize matches the pi-multi-edit hint rounding", () => {
  assert.strictEqual(fmtSize(0), "0");
  assert.strictEqual(fmtSize(999), "999");
  assert.strictEqual(fmtSize(1000), "1k");
  assert.strictEqual(fmtSize(1837), "1.8k");
  assert.strictEqual(fmtSize(25788), "25.8k");
});

test("shortenPath collapses the home directory", () => {  const key = process.env.HOME ? "HOME" : "USERPROFILE";
  const previous = process.env[key];
  process.env[key] = "C:/Users/user";
  try {
    assert.strictEqual(shortenPath("C:/Users/user/.pi/agent/settings.json"), "~/.pi/agent/settings.json");
    assert.strictEqual(shortenPath("C:/p/a.ts"), "C:/p/a.ts");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("timer ticks while incomplete and is cleared once settled", () => {
  const state: WriteRowState = {};
  let invalidations = 0;
  const elapsed = syncWriteTimer(state, { running: true, invalidate: () => invalidations++, now: 1000 });
  assert.strictEqual(elapsed, 0);
  assert.ok(state.interval, "interval installed while running");
  assert.strictEqual(syncWriteTimer(state, { running: true, invalidate: () => invalidations++, now: 4500 }), 3500);
  assert.strictEqual(syncWriteTimer(state, { running: false, invalidate: () => invalidations++ }), undefined);
  assert.strictEqual(state.interval, undefined, "interval cleared when the row settles");
test("an explicit path wins over the args (executed call / content match)", () => {
  assert.strictEqual(
    formatWriteHeader({ content: "x".repeat(1200) }, theme, { settled: true, path: "src/app.ts" }),
    "write src/app.ts 1.2k, 1 line",
  );
  assert.strictEqual(
    formatWriteHeader({ path: "old.ts", content: "x" }, theme, { path: "new.ts" }),
    "write new.ts +1, 1 line",
  );
});

test("matchRecentPath finds the call behind a path-less row by content prefix", () => {
  const recent = [
    { path: "a.txt", content: "alpha\nbeta\n" },
    { path: "b.txt", content: "beta\ngamma\n" },
  ];
  // The row streamed only the head of the content; newest match wins.
  assert.strictEqual(matchRecentPath(recent, "beta\n"), "b.txt");
  assert.strictEqual(matchRecentPath(recent, "alpha"), "a.txt");
  assert.strictEqual(matchRecentPath(recent, "alpha\nbeta\n"), "a.txt");
  assert.strictEqual(matchRecentPath(recent, "nothing alike"), undefined);
  assert.strictEqual(matchRecentPath(recent, ""), undefined);
  assert.strictEqual(matchRecentPath([], "x"), undefined);
});

});
