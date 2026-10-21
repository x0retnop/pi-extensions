import assert from "node:assert";
import { describe, it } from "node:test";

import {
  joinStatusBlocks,
  placeLeftRight,
  stripStatusSuffix,
} from "../../ui-theme/footer.js";
import {
  consumedStatusKeys,
  isCellId,
  renderFlow,
  renderLayoutRows,
  splitTimerText,
} from "../../ui-theme/layout.js";
import {
  emptyLayout,
  normalizeStatusSep,
  parseFooterLayout,
  parseFooterRow,
} from "../../ui-theme/settings.js";
import { loadPresets } from "../../ui-theme/presets.js";
import { visibleLen } from "../../ui-theme/paint.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("footer statusSep", () => {
  it("strips only the trailing setStatusBlock pipe", () => {
    assert.strictEqual(stripStatusSuffix("web:on |"), "web:on");
    assert.strictEqual(stripStatusSuffix("0:00 · 0:00 | 12 · 3 |"), "0:00 · 0:00 | 12 · 3");
    assert.strictEqual(stripStatusSuffix("role:kimi"), "role:kimi");
  });

  it("joins blocks with the preset sep", () => {
    assert.strictEqual(joinStatusBlocks(["web:on", "sub:on"], " | "), "web:on | sub:on");
    assert.strictEqual(joinStatusBlocks(["web:on", "sub:on"], " · "), "web:on · sub:on");
    assert.strictEqual(joinStatusBlocks(["web:on", ""], " | "), "web:on");
  });

  it("normalizeStatusSep keeps spaces and caps length", () => {
    assert.strictEqual(normalizeStatusSep(" | "), " | ");
    assert.strictEqual(normalizeStatusSep("\n|\t"), "|");
    assert.strictEqual(normalizeStatusSep(""), "");
    assert.strictEqual(normalizeStatusSep("123456789"), "12345678");
  });
});

describe("footer placeLeftRight", () => {
  it("pins the right side and pads the middle", () => {
    assert.strictEqual(strip(placeLeftRight("cwd", "model", 16)), "cwd        model");
  });

  it("truncates the right side first when tight", () => {
    assert.strictEqual(strip(placeLeftRight("cwd-path", "grok-4.6", 14)), "cwd-path  grok");
  });
});

describe("footer layout parse", () => {
  it("treats punctuation tokens as literals and | as left/right split", () => {
    assert.strictEqual(isCellId("clock"), true);
    assert.strictEqual(isCellId("_"), true);
    assert.strictEqual(isCellId("sub-agents"), true);
    assert.strictEqual(isCellId("·"), false);
    const row = parseFooterRow("clock · timer tools | model");
    assert.deepStrictEqual(row, {
      left: ["clock", "·", "timer", "tools"],
      right: ["model"],
    });
  });

  it("parses cell widths as number or {w, align}", () => {
    const l = parseFooterLayout({
      embed: true,
      pad: 3,
      sep: " ░ ",
      cells: { timer: 13, tools: { w: 9, align: "right" } },
      rows: ["usage"],
    });
    assert.strictEqual(l.embed, true);
    assert.strictEqual(l.pad, 3);
    assert.strictEqual(l.sep, " ░ ");
    assert.deepStrictEqual(l.cells.timer, { w: 13, align: "left" });
    assert.deepStrictEqual(l.cells.tools, { w: 9, align: "right" });
    assert.deepStrictEqual(l.rows[0], { left: ["usage"], right: [] });
  });

  it("empty / missing layout is stock", () => {
    const e = emptyLayout();
    assert.strictEqual(e.rows.length, 0);
    assert.deepStrictEqual(parseFooterLayout({}), e);
    assert.deepStrictEqual(parseFooterLayout(null), e);
  });
});

describe("footer layout render", () => {
  it("splits a-rewind timer into total / last / tools (ANSI-safe)", () => {
    assert.deepStrictEqual(splitTimerText("0:43 · 0:12 | 30 · 0"), {
      total: "0:43",
      last: "0:12",
      timer: "0:43 · 0:12",
      tools: "30 · 0",
    });
    assert.deepStrictEqual(splitTimerText("\x1b[33m0:05\x1b[0m | 1 · 0"), {
      total: "0:05",
      last: "",
      timer: "0:05",
      tools: "1 · 0",
    });
    // yellow wrap eats the space before | — must still split
    assert.deepStrictEqual(splitTimerText("\x1b[33m0:00 \x1b[0m| 0 · 0"), {
      total: "0:00",
      last: "",
      timer: "0:00",
      tools: "0 · 0",
    });
  });

  it("keeps neighbors still when dynamic text changes width", () => {
    const layout = parseFooterLayout({
      sep: " ░ ",
      cells: {
        tools: { w: 9, align: "right" },
        turn: 12,
      },
      rows: ["tools turn | model"],
    });
    const a = renderLayoutRows(
      layout,
      { tools: "1 · 0", turn: "✓ 1.0s", model: "grok" },
      40,
      " | ",
    );
    const b = renderLayoutRows(
      layout,
      { tools: "30 · 0", turn: "✓ 43.0s", model: "grok" },
      40,
      " | ",
    );
    assert.strictEqual(visibleLen(a[0]), 40);
    assert.strictEqual(visibleLen(b[0]), 40);
    assert.strictEqual(strip(a[0]).indexOf("✓"), strip(b[0]).indexOf("✓"));
    assert.strictEqual(strip(a[0]).indexOf("grok"), strip(b[0]).indexOf("grok"));
  });

  it("literal sep sits only between the two cells it joins", () => {
    const layout = parseFooterLayout({
      sep: " ░ ",
      rows: ["clock · timer tools"],
    });
    const line = renderFlow(
      layout.rows[0].left,
      { clock: "11:01", timer: "0:43", tools: "30 · 0" },
      layout,
      " ░ ",
    );
    assert.strictEqual(line, "11:01 · 0:43 ░ 30 · 0");
  });

  it("fixed-width empty cell still occupies its slot", () => {
    const layout = parseFooterLayout({
      sep: "|",
      cells: { turn: 8 },
      rows: ["rate turn"],
    });
    const line = renderFlow(layout.rows[0].left, { rate: "▸", turn: "" }, layout, "|");
    assert.strictEqual(line, "▸|        ");
    assert.strictEqual(visibleLen(line), 10);
  });

  it("marks timer/tools/turn as consuming the status keys", () => {
    const used = consumedStatusKeys([
      { left: ["timer", "tools", "turn", "role"], right: ["status"] },
    ]);
    assert.ok(used.has("_"));
    assert.ok(used.has("zz-turn"));
    assert.ok(used.has("role"));
    assert.ok(!used.has("web-access"));
  });
});

describe("footer 3v preset", () => {
  it("ships with embed rows and fixed widths for jumpy cells", () => {
    const p = loadPresets().find((x) => x.id === "3v");
    assert.ok(p);
    const l = p!.chrome.layout as ReturnType<typeof parseFooterLayout>;
    assert.strictEqual(l.embed, true);
    assert.strictEqual(l.pad, 3);
    assert.ok((l.cells.total?.w ?? 0) >= 5);
    assert.ok((l.cells.last?.w ?? 0) >= 4);
    assert.ok((l.cells.tools?.w ?? 0) >= 6);
    assert.ok((l.cells.turn?.w ?? 0) >= 8);
    assert.ok((l.cells["rate-bar"]?.w ?? 0) >= 10);
    assert.ok((l.cells["rate-num"]?.w ?? 0) >= 4);
    assert.strictEqual(p!.chrome.barStyle, "rise");
    assert.strictEqual(l.rows.length, 3);
    assert.ok(l.rows[0].left.includes("total"));
    assert.ok(l.rows[0].left.includes("last"));
    assert.ok(!l.rows[0].left.includes("clock"));
    assert.ok(l.rows[0].right.includes("model"));
    assert.ok(l.rows[2].left.includes("cwd"));
  });
});
