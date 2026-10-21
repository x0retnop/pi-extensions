import { test } from "node:test";
import assert from "node:assert";

import {
  bodyLagMs,
  buildToolDiag,
  classifyStream,
  classifyTool,
  emptyHeaderMs,
  milestonesClustered,
  streamUi,
  toolUi,
  type ToolLag,
} from "../../stream-tool-log/verdict.js";

function lag(partial: Partial<ToolLag> & Pick<ToolLag, "name">): ToolLag {
  return {
    argBytes: 0,
    contentLen: 0,
    streamMs: 0,
    deltas: 0,
    pathAtMs: null,
    contentAtMs: null,
    oldAtMs: null,
    newAtMs: null,
    ...partial,
  };
}

test("grok write dump: path+content same ms, Δ1, 11KB → provider_buffer", () => {
  const t = lag({
    name: "write",
    argBytes: 11102,
    contentLen: 10874,
    streamMs: 536,
    deltas: 1,
    pathAtMs: 92,
    contentAtMs: 92,
  });
  assert.strictEqual(classifyTool(t), "provider_buffer");
  assert.strictEqual(emptyHeaderMs(t), 92);
  assert.deepStrictEqual(toolUi(t, "provider_buffer"), ["full_pop"]);
  assert.ok(milestonesClustered(t));
});

test("grok write already complete at tc_start → provider_buffer, no ellipsis", () => {
  const t = lag({
    name: "write",
    argBytes: 11092,
    contentLen: 10900,
    streamMs: 436,
    deltas: 1,
    pathAtMs: 0,
    contentAtMs: 0,
  });
  assert.strictEqual(classifyTool(t), "provider_buffer");
  assert.strictEqual(emptyHeaderMs(t), 0);
  assert.deepStrictEqual(toolUi(t, "provider_buffer"), ["full_pop"]);
});

test("kimi write progressive: many deltas, path then growing content", () => {
  const t = lag({
    name: "write",
    argBytes: 631,
    contentLen: 551,
    streamMs: 1806,
    deltas: 154,
    pathAtMs: 1,
    contentAtMs: 61,
  });
  assert.strictEqual(classifyTool(t), "progressive");
  assert.strictEqual(bodyLagMs(t), 60);
  assert.deepStrictEqual(toolUi(t, "progressive"), ["grow"]);
});

test("deepseek write 11KB over 27s → progressive", () => {
  const t = lag({
    name: "write",
    argBytes: 10937,
    contentLen: 10688,
    streamMs: 26878,
    deltas: 3275,
    pathAtMs: 59,
    contentAtMs: 382,
  });
  assert.strictEqual(classifyTool(t), "progressive");
});

test("grok edit dump Δ1 clustered → provider_buffer", () => {
  const t = lag({
    name: "edit",
    argBytes: 2141,
    streamMs: 15083,
    deltas: 1,
    pathAtMs: 0,
    oldAtMs: 0,
    newAtMs: 0,
  });
  assert.strictEqual(classifyTool(t), "provider_buffer");
});

test("path only at the end of a dump → header_late", () => {
  const t = lag({
    name: "write",
    argBytes: 4000,
    contentLen: 3800,
    streamMs: 4000,
    deltas: 1,
    pathAtMs: 3900,
    contentAtMs: 200,
  });
  assert.strictEqual(classifyTool(t), "header_late");
  assert.strictEqual(emptyHeaderMs(t), 3900);
});

test("Kimi key-order: new first, path last, many deltas → progressive", () => {
  const t = lag({
    name: "edit",
    argBytes: 3675,
    streamMs: 31863,
    deltas: 1629,
    pathAtMs: 31848,
    oldAtMs: 18776,
    newAtMs: 0,
  });
  assert.strictEqual(classifyTool(t), "progressive");
  assert.strictEqual(emptyHeaderMs(t), 31848);
});

test("path never arrived → header_late", () => {
  const t = lag({
    name: "write",
    argBytes: 8000,
    contentLen: 0,
    streamMs: 4000,
    deltas: 2,
  });
  assert.strictEqual(classifyTool(t), "header_late");
  assert.strictEqual(emptyHeaderMs(t), 4000);
});

test("tiny write is unknown, not blamed", () => {
  const t = lag({
    name: "write",
    argBytes: 80,
    contentLen: 20,
    streamMs: 40,
    deltas: 1,
    pathAtMs: 0,
    contentAtMs: 0,
  });
  assert.strictEqual(classifyTool(t), "unknown");
});

test("stream verdicts: buffer / progressive / mixed / silence ui", () => {
  const buf = buildToolDiag(
    lag({
      name: "write",
      argBytes: 8000,
      contentLen: 7000,
      streamMs: 400,
      deltas: 1,
      pathAtMs: 80,
      contentAtMs: 80,
    }),
  );
  const prog = buildToolDiag(
    lag({
      name: "write",
      argBytes: 800,
      contentLen: 600,
      streamMs: 1800,
      deltas: 120,
      pathAtMs: 1,
      contentAtMs: 50,
    }),
  );
  assert.strictEqual(classifyStream([buf]), "provider_buffer");
  assert.strictEqual(classifyStream([prog]), "progressive");
  assert.strictEqual(classifyStream([buf, prog]), "mixed");
  assert.strictEqual(classifyStream([]), "none");
  assert.deepStrictEqual(streamUi(49591, [{ ui: toolUi(buf, buf.verdict) }]), ["blank", "full_pop"]);
  assert.deepStrictEqual(streamUi(0, [{ ui: toolUi(prog, prog.verdict) }]), ["grow"]);
});

test("ellipsis when empty header lasts >= 200ms", () => {
  const t = lag({
    name: "write",
    argBytes: 9000,
    contentLen: 8000,
    streamMs: 600,
    deltas: 1,
    pathAtMs: 250,
    contentAtMs: 250,
  });
  assert.strictEqual(classifyTool(t), "provider_buffer");
  assert.deepStrictEqual(toolUi(t, "provider_buffer"), ["ellipsis", "full_pop"]);
});
