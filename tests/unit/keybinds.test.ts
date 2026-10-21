import assert from "node:assert";
import { describe, it } from "node:test";

import {
  compareBindings,
  formatKeys,
  groupOf,
  keysColWidth,
  listDescWidth,
  padLabel,
} from "../../keybinds/store.js";

describe("keybinds groupOf", () => {
  it("keeps session/tree/filter in one group each", () => {
    assert.strictEqual(groupOf("app.session.new"), "session");
    assert.strictEqual(groupOf("app.session.deleteNoninvasive"), "session");
    assert.strictEqual(groupOf("app.tree.foldOrUp"), "tree");
    assert.strictEqual(groupOf("app.tree.filter.userOnly"), "tree filter");
    assert.strictEqual(groupOf("app.models.save"), "model picker");
    assert.strictEqual(groupOf("app.model.select"), "model");
    assert.strictEqual(groupOf("app.editor.external"), "external editor");
    assert.strictEqual(groupOf("tui.altScreen.top"), "scroll");
  });
});

describe("keybinds compareBindings", () => {
  it("clusters split session ids together", () => {
    const ids = [
      "app.session.toggleNamedFilter",
      "app.model.select",
      "app.session.new",
      "app.tree.foldOrUp",
      "app.session.delete",
    ];
    const sorted = ids
      .map((id) => ({ id, group: groupOf(id) }))
      .sort(compareBindings)
      .map((b) => b.id);
    assert.deepStrictEqual(sorted, [
      "app.model.select",
      "app.session.delete",
      "app.session.new",
      "app.session.toggleNamedFilter",
      "app.tree.foldOrUp",
    ]);
  });
});

describe("keybinds list layout", () => {
  it("formatKeys uses off for empty", () => {
    assert.strictEqual(formatKeys([]), "off");
    assert.strictEqual(formatKeys(["ctrl+p", "ctrl+l"]), "ctrl+p, ctrl+l");
  });

  it("pads short labels and ellipsizes long ones", () => {
    assert.strictEqual(padLabel("Yank", 8), "Yank    ");
    assert.strictEqual(padLabel("Delete character backward", 10), "Delete ch…");
    assert.strictEqual(padLabel("XY", 1), "…");
  });

  it("keeps a keys column so a long description cannot eat the keys", () => {
    const keyW = keysColWidth(["shift+tab", "off", "alt+left, ctrl+left, alt+b"]);
    assert.strictEqual(keyW, 26);
    const descW = listDescWidth(40, keyW);
    assert.strictEqual(descW, 12);
    const row = padLabel("Cycle thinking level", descW) + "shift+tab";
    assert.ok(row.endsWith("shift+tab"));
    assert.strictEqual(row.length, descW + "shift+tab".length);
  });
});
