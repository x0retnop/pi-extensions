import assert from "node:assert";
import { describe, it } from "node:test";

import {
  BOOT_DEFAULTS,
  queueBootRibbon,
  takeBootRibbon,
  bootPatchFromRaw,
  loadSurfaceChrome,
  mergeBootSettings,
  parseBootSettings,
  renderRibbon,
  resolveBootFrame,
  toSurfaceChrome,
  withRibbonGap,
} from "../../common/chrome.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const groups = [
  { label: "prompt", items: ["date", "workdir"] },
  { label: "tools", items: ["bash"] },
];

describe("common chrome boot settings", () => {
  it("defaults are unframed prefix ribbon", () => {
    const s = parseBootSettings(undefined);
    assert.strictEqual(s.frame, "none");
    assert.strictEqual(s.title, "prefix");
    assert.strictEqual(s.rails, false);
    assert.strictEqual(s.sep, " · ");
  });

  it("bootPatchFromRaw keeps only listed keys", () => {
    const patch = bootPatchFromRaw({ frame: "double", catMark: " ►", nope: 1 });
    assert.deepStrictEqual(patch, { frame: "double", catMark: " ►" });
    const merged = mergeBootSettings(
      { ...BOOT_DEFAULTS, itemLead: "▐ " },
      patch,
    );
    assert.strictEqual(merged.frame, "double");
    assert.strictEqual(merged.catMark, " ►");
    assert.strictEqual(merged.itemLead, "▐ ");
  });

  it("rejects unknown frame ids", () => {
    assert.strictEqual(parseBootSettings({ frame: "wave" }).frame, "none");
    assert.strictEqual(bootPatchFromRaw({ frame: "wave" }), undefined);
  });

  it("loadSurfaceChrome inherits footer hex", () => {
    const chrome = loadSurfaceChrome({
      uiTheme: {
        frameBlu: "#ff2ea8",
        framePur: "#18f0ff",
        boot: { frame: "sharp" },
      },
    });
    assert.strictEqual(chrome.frame, "sharp");
    assert.strictEqual(chrome.frameBlu, "#ff2ea8");
    assert.strictEqual(chrome.framePur, "#18f0ff");
  });

  it("loadSurfaceChrome frames none as the footer style", () => {
    const chrome = loadSurfaceChrome({
      uiTheme: {
        frameStyle: "double",
        boot: { frame: "none" },
      },
    });
    assert.strictEqual(chrome.frame, "double");
  });

  it("resolveBootFrame keeps an explicit box and falls back to footer/sharp", () => {
    assert.strictEqual(resolveBootFrame("rounded", "double"), "rounded");
    assert.strictEqual(resolveBootFrame("none", "double"), "double");
    assert.strictEqual(resolveBootFrame("none", "wave"), "sharp");
  });

  it("withRibbonGap adds exactly one trailing blank", () => {
    assert.deepStrictEqual(withRibbonGap(["a", "b"]), ["a", "b", ""]);
    assert.deepStrictEqual(withRibbonGap(["a", ""]), ["a", ""]);
    assert.deepStrictEqual(withRibbonGap([]), []);
  });

  it("queue/take boot ribbon is one-shot and last-write-wins", () => {
    queueBootRibbon(["a", "b"]);
    assert.deepStrictEqual(takeBootRibbon(), ["a", "b"]);
    assert.strictEqual(takeBootRibbon(), undefined);
    queueBootRibbon([]);
    assert.strictEqual(takeBootRibbon(), undefined);
    queueBootRibbon(["x"]);
    queueBootRibbon(["y"]);
    assert.deepStrictEqual(takeBootRibbon(), ["y"]);
  });
});

describe("common renderRibbon", () => {
  it("plain prefix, enabled items only", () => {
    const lines = renderRibbon(groups, toSurfaceChrome(BOOT_DEFAULTS)).map(strip);
    assert.deepStrictEqual(lines, ["prompt  date · workdir", "tools  bash"]);
  });

  it("drops empty groups; empty input is empty", () => {
    assert.deepStrictEqual(renderRibbon([{ label: "prompt", items: [] }], toSurfaceChrome(BOOT_DEFAULTS)), []);
    assert.deepStrictEqual(renderRibbon([], toSurfaceChrome(BOOT_DEFAULTS)), []);
  });

  it("double box hugs content width", () => {
    const lines = renderRibbon(
      groups,
      toSurfaceChrome({ ...BOOT_DEFAULTS, frame: "double" }),
    ).map(strip);
    assert.strictEqual(lines[0][0], "╔");
    assert.strictEqual(lines.at(-1)![0], "╚");
    assert.ok(lines[1].includes("prompt"));
    const w = lines[0].length;
    for (const line of lines) assert.strictEqual(line.length, w);
  });

  it("in-border title + extras + rails", () => {
    const lines = renderRibbon(
      groups,
      toSurfaceChrome({
        ...BOOT_DEFAULTS,
        frame: "sharp",
        title: "in-border",
        frameTitle: "guard",
        rails: true,
        catMark: " ►",
        itemLead: "▐ ",
        itemMark: " ✓",
      }),
    ).map(strip);
    assert.ok(lines[0].startsWith("▓▓"));
    assert.match(lines[1], /┌ guard ─+┐/);
    assert.match(lines[2], /prompt ► ▐ date ✓ · ▐ workdir ✓/);
    assert.ok(lines.at(-1)!.startsWith("▓▓"));
  });
});
