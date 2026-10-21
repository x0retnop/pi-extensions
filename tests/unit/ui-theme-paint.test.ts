import assert from "node:assert";
import { describe, it } from "node:test";

import {
  barParts,
  fitVisible,
  frameBox,
  normalizeBarStyle,
  normalizeFrameFill,
  normalizeFrameStyle,
  padStartVisible,
  visibleLen,
} from "../../ui-theme/paint.js";
import {
  DEFAULTS,
  applyChromePatch,
  loadUiThemeSettings,
  normalizeFrameTitle,
  parseFooterLayout,
} from "../../ui-theme/settings.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ui-theme fitVisible", () => {
  it("pads left or right to a fixed visible width", () => {
    assert.strictEqual(padStartVisible("ab", 5), "   ab");
    assert.strictEqual(fitVisible("ab", 5, "left"), "ab   ");
    assert.strictEqual(fitVisible("ab", 5, "right"), "   ab");
  });

  it("truncates to width and ignores ANSI", () => {
    const painted = "\x1b[33m12345\x1b[0m";
    assert.strictEqual(visibleLen(fitVisible(painted, 3, "left")), 3);
    assert.strictEqual(fitVisible("abcdef", 3, "left"), "abc");
    assert.strictEqual(fitVisible("hi", 0), "hi");
  });
});

describe("ui-theme frame styles", () => {
  it("defaults keep the original sharp box", () => {
    const lines = frameBox(["hi"], 8);
    assert.strictEqual(strip(lines[0])[0], "┌");
    assert.strictEqual(strip(lines[0]).at(-1), "┐");
    assert.strictEqual(strip(lines.at(-1)!)[0], "└");
    assert.ok(strip(lines[0]).includes("─"));
  });

  it("double / rounded / heavy / ascii / block swap glyphs", () => {
    assert.strictEqual(strip(frameBox(["x"], 6, { style: "double" })[0])[0], "╔");
    assert.strictEqual(strip(frameBox(["x"], 6, { style: "rounded" })[0])[0], "╭");
    assert.strictEqual(strip(frameBox(["x"], 6, { style: "heavy" })[0])[0], "┏");
    assert.strictEqual(strip(frameBox(["x"], 6, { style: "ascii" })[0])[0], "+");
    assert.strictEqual(strip(frameBox(["x"], 6, { style: "block" })[0])[0], "▛");
    assert.ok(strip(frameBox(["x"], 6, { style: "double" })[0]).includes("═"));
  });

  it("every line is innerW+2 visible cols", () => {
    for (const style of ["sharp", "double", "block"] as const) {
      const lines = frameBox(["abc", ""], 10, { style, title: "ICE" });
      for (const line of lines) {
        assert.strictEqual(visibleLen(line), 12, strip(line));
      }
    }
  });

  it("embed puts first/last content in the corners (no extra rule rows)", () => {
    const lines = frameBox(["top", "mid", "bot"], 10, { style: "rounded", embed: true });
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(strip(lines[0])[0], "╭");
    assert.strictEqual(strip(lines[0]).at(-1), "╮");
    assert.ok(strip(lines[0]).includes("top"));
    assert.ok(!strip(lines[0]).includes("─"));
    assert.ok(strip(lines[1]).includes("mid"));
    assert.strictEqual(strip(lines[1])[0], " ");
    assert.strictEqual(strip(lines[2])[0], "╰");
    assert.ok(strip(lines[2]).includes("bot"));
    for (const line of lines) assert.strictEqual(visibleLen(line), 12, strip(line));
  });

  it("title sits on the top rule", () => {
    const top = strip(frameBox(["z"], 16, { style: "double", title: "ICE" })[0]);
    assert.match(top, /╔ ICE ═+╗/);
  });

  it("solid uses one color; fade uses many", () => {
    const solid = frameBox(["z"], 12, {
      fill: "solid",
      bluHex: "#ff0000",
      purHex: "#00ff00",
    })[0];
    const fade = frameBox(["z"], 12, {
      fill: "fade",
      bluHex: "#ff0000",
      purHex: "#00ff00",
    })[0];
    assert.ok(solid.includes("38;2;255;0;0"));
    assert.ok(!solid.includes("38;2;0;255;0"));
    assert.ok(fade.includes("38;2;255;0;0"));
    assert.ok(fade.includes("38;2;0;255;0"));
    const codes = fade.match(/38;2;\d+;\d+;\d+/g) ?? [];
    assert.ok(new Set(codes).size >= 4);
  });
});

describe("ui-theme bar styles", () => {
  it("block / hash / dot split fill vs empty", () => {
    assert.deepStrictEqual(barParts(0.5, 8, "block"), { hot: "████", cold: "░░░░" });
    assert.deepStrictEqual(barParts(0.5, 8, "hash"), { hot: "####", cold: "----" });
    assert.deepStrictEqual(barParts(0.5, 8, "dot"), { hot: "●●●●", cold: "○○○○" });
  });

  it("density tapers the leading edge", () => {
    const { hot, cold } = barParts(0.5, 8, "density");
    assert.strictEqual(hot + cold, "██▓▒░░░░");
    assert.strictEqual((hot + cold).length, 8);
  });

  it("rise lights a unique step of ▁▂▃▅▆▇█▓ per cell", () => {
    assert.deepStrictEqual(barParts(0, 8, "rise"), { hot: "", cold: "        " });
    assert.deepStrictEqual(barParts(0.5, 8, "rise"), { hot: "▁▂▃▅", cold: "    " });
    assert.deepStrictEqual(barParts(1, 8, "rise"), { hot: "▁▂▃▅▆▇█▓", cold: "" });
    assert.strictEqual((barParts(0.25, 8, "rise").hot + barParts(0.25, 8, "rise").cold).length, 8);
  });
});

describe("ui-theme chrome normalize", () => {
  it("rejects unknown style ids", () => {
    assert.strictEqual(normalizeFrameStyle("nope"), "sharp");
    assert.strictEqual(normalizeFrameFill("wave"), "split");
    assert.strictEqual(normalizeBarStyle("rainbow"), "block");
    assert.strictEqual(normalizeFrameTitle("  ICE \n x  "), "ICE x");
  });

  it("applyChromePatch only writes listed keys", () => {
    const next = applyChromePatch(DEFAULTS, {
      frameStyle: "double",
      frameFill: "fade",
      frameTitle: "ICE",
      barStyle: "density",
      statusSep: " · ",
    });
    assert.strictEqual(next.frameStyle, "double");
    assert.strictEqual(next.frameFill, "fade");
    assert.strictEqual(next.frameTitle, "ICE");
    assert.strictEqual(next.barStyle, "density");
    assert.strictEqual(next.statusSep, " · ");
    assert.strictEqual(next.frameBlu, DEFAULTS.frameBlu);
    assert.strictEqual(next.footer, DEFAULTS.footer);
    assert.strictEqual(next.boot.frame, "none");
  });

  it("applyChromePatch replaces layout when listed", () => {
    const withRows = applyChromePatch(DEFAULTS, {
      layout: { rows: ["usage"], cells: { role: 10 } },
    });
    assert.strictEqual(withRows.layout.rows.length, 1);
    assert.strictEqual(withRows.layout.cells.role.w, 10);
    const cleared = applyChromePatch(withRows, { layout: {} });
    assert.strictEqual(cleared.layout.rows.length, 0);
    assert.deepStrictEqual(cleared.layout, parseFooterLayout({}));
  });

  it("applyChromePatch merges boot extras without wiping the rest", () => {
    const base = applyChromePatch(DEFAULTS, { boot: { itemLead: "▐ " } });
    const next = applyChromePatch(base, { boot: { frame: "double", catMark: " ►" } });
    assert.strictEqual(next.boot.frame, "double");
    assert.strictEqual(next.boot.catMark, " ►");
    assert.strictEqual(next.boot.itemLead, "▐ ");
    assert.strictEqual(next.boot.title, "prefix");
  });

  it("loadUiThemeSettings defaults missing shape keys to sharp/split/block", () => {
    const s = loadUiThemeSettings({ uiTheme: { footer: true } });
    assert.strictEqual(s.frameStyle, "sharp");
    assert.strictEqual(s.frameFill, "split");
    assert.strictEqual(s.barStyle, "block");
    assert.strictEqual(s.frameTitle, "");
  });
});
