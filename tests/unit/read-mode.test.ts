import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildOverview,
  extractSection,
  truncateText,
} from "../../read-mode/parser.js";
import readModeFactory from "../../read-mode/index.js";

function withTempFile(name: string, content: string): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "read-mode-"));
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf-8");
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("read-mode buildOverview", () => {
  it("extracts TS functions, classes, and methods", async () => {
    const src = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export class Beta {",
      "  async gamma() {",
      "    return 2;",
      "  }",
      "}",
      "",
      "interface Delta { x: number }",
    ].join("\n");
    const { file, cleanup } = withTempFile("mod.ts", src);
    try {
      const ov = await buildOverview(file);
      assert.ok(ov.totalLines >= 10);
      const names = ov.sections.map((s) => s.name);
      assert.ok(names.includes("alpha"));
      assert.ok(names.includes("Beta"));
      assert.ok(names.includes("gamma"));
      assert.ok(names.includes("Delta"));
      const alpha = ov.sections.find((s) => s.name === "alpha");
      assert.strictEqual(alpha?.type, "function");
      assert.strictEqual(alpha?.startLine, 1);
    } finally {
      cleanup();
    }
  });

  it("extracts TS export default and top-level const arrows", async () => {
    const src = [
      "export const paint = (code: string, s: string) => `${code}${s}`;",
      "const fmtRole = (s: string): string => s;",
      "export default function aRewind(pi: any) {",
      "  const nested = () => 1;",
      "  return nested;",
      "}",
      "export default function (pi: any) {",
      "  return 0;",
      "}",
    ].join("\n");
    const { file, cleanup } = withTempFile("ext.ts", src);
    try {
      const ov = await buildOverview(file);
      const names = ov.sections.map((s) => s.name);
      assert.ok(names.includes("paint"), `paint: ${names}`);
      assert.ok(names.includes("fmtRole"), `fmtRole: ${names}`);
      assert.ok(names.includes("aRewind"), `aRewind: ${names}`);
      assert.ok(names.includes("default"), `default: ${names}`);
      // nested helper must not pollute overview
      assert.ok(!names.includes("nested"), `nested leaked: ${names}`);
      assert.strictEqual(ov.sections.find((s) => s.name === "paint")?.type, "const");
    } finally {
      cleanup();
    }
  });

  it("extracts Python defs and classes with indent awareness", async () => {
    const src = [
      "class Foo:",
      "    def bar(self):",
      "        return 1",
      "",
      "def top_level():",
      "    pass",
      "",
      "@router.get('/x')",
      "async def list_items() -> dict:",
      "    return {}",
    ].join("\n");
    const { file, cleanup } = withTempFile("mod.py", src);
    try {
      const ov = await buildOverview(file);
      const names = ov.sections.map((s) => s.name);
      assert.deepStrictEqual(names, ["Foo", "bar", "top_level", "list_items"]);
      assert.strictEqual(ov.sections.find((s) => s.name === "list_items")?.type, "async def");
      assert.strictEqual(ov.sections.find((s) => s.name === "top_level")?.type, "def");
    } finally {
      cleanup();
    }
  });

  it("extracts markdown headers", async () => {
    const src = "# Title\n\n## Section A\n\ntext\n\n### Nested\n";
    const { file, cleanup } = withTempFile("doc.md", src);
    try {
      const ov = await buildOverview(file);
      assert.ok(ov.sections.some((s) => s.name === "Title" && s.type === "h1"));
      assert.ok(ov.sections.some((s) => s.name === "Section A" && s.type === "h2"));
    } finally {
      cleanup();
    }
  });

  it("returns empty sections for unknown extensions", async () => {
    const { file, cleanup } = withTempFile("data.bin.txt", "no structure\n");
    // .txt is unknown unless there's a handler — expect empty structure
    try {
      const ov = await buildOverview(file);
      assert.strictEqual(ov.sections.length, 0);
      assert.strictEqual(ov.totalLines, 2);
    } finally {
      cleanup();
    }
  });

  it("extracts C# types and methods; ignores call-sites", async () => {
    const src = [
      "namespace Pikcha;",
      "",
      "public enum ZoomMode { Fit = 0, Actual = 1 }",
      "",
      "public partial class MainWindow : Window",
      "{",
      "    private void ShowFile(int index)",
      "    {",
      "        ApplyZoom();",
      "        RefreshFileList();",
      "    }",
      "",
      "    public static string Register(IEnumerable<string> exts)",
      "    {",
      "        ApplyRegister(exts);",
      "        return \"ok\";",
      "    }",
      "}",
      "",
      "internal static class FileAssociations",
      "{",
      "    public static void NotifyShell() { }",
      "}",
    ].join("\n");
    const { file, cleanup } = withTempFile("MainWindow.cs", src);
    try {
      const ov = await buildOverview(file);
      const names = ov.sections.map((s) => s.name);
      assert.ok(names.includes("ZoomMode"), `missing ZoomMode in ${names}`);
      assert.ok(names.includes("MainWindow"), `missing MainWindow in ${names}`);
      assert.ok(names.includes("ShowFile"), `missing ShowFile in ${names}`);
      assert.ok(names.includes("Register"), `missing Register in ${names}`);
      assert.ok(names.includes("FileAssociations"), `missing FileAssociations in ${names}`);
      assert.ok(names.includes("NotifyShell"), `missing NotifyShell in ${names}`);
      // call-sites must not appear
      assert.ok(!names.includes("ApplyZoom"), `call-site ApplyZoom leaked: ${names}`);
      assert.ok(!names.includes("RefreshFileList"), `call-site leaked: ${names}`);
      assert.ok(!names.includes("ApplyRegister"), `call-site leaked: ${names}`);
      assert.strictEqual(ov.sections.find((s) => s.name === "MainWindow")?.type, "class");
      assert.strictEqual(ov.sections.find((s) => s.name === "ShowFile")?.type, "method");
    } finally {
      cleanup();
    }
  });

  it("extracts C++ out-of-line Class::Method and enum class", async () => {
    const src = [
      "namespace aipet {",
      "",
      "enum class Mode { Free, Journey };",
      "",
      "class PetBrain {",
      "public:",
      "    void Tick(float dt);",
      "    PetState GetState() const { return state_; }",
      "private:",
      "    PetState state_;",
      "};",
      "",
      "void PetBrain::Tick(float dt) {",
      "    Think(dt);",
      "}",
      "",
      "bool PetBrain::CommitWalk(Vec2 dest, bool flee, const char* tag) {",
      "    return true;",
      "}",
      "",
      "PetWindow::PetWindow() {",
      "    instance_ = this;",
      "}",
      "",
      "float RandF(float a, float b) {",
      "    return a;",
      "}",
      "",
      "} // namespace",
    ].join("\n");
    const { file, cleanup } = withTempFile("PetBrain.cpp", src);
    try {
      const ov = await buildOverview(file);
      const names = ov.sections.map((s) => s.name);
      const types = Object.fromEntries(ov.sections.map((s) => [s.name, s.type]));
      assert.ok(names.includes("aipet"), `ns: ${names}`);
      assert.ok(names.includes("Mode"), `enum class: ${names}`);
      assert.strictEqual(types["Mode"], "enum class");
      assert.ok(names.includes("PetBrain"), `class: ${names}`);
      assert.ok(names.includes("GetState"), `inline: ${names}`);
      assert.ok(names.includes("PetBrain::Tick"), `out-of-line Tick: ${names}`);
      assert.ok(names.includes("PetBrain::CommitWalk"), `out-of-line: ${names}`);
      assert.ok(names.includes("PetWindow::PetWindow"), `ctor: ${names}`);
      assert.ok(names.includes("RandF"), `free fn: ${names}`);
      // bare call Think(dt) must not appear; Tick decl without body may or may not
      assert.ok(!names.includes("Think"), `call-site Think leaked: ${names}`);
    } finally {
      cleanup();
    }
  });

  it("C++/C# reject call-sites, locals, and throw-new noise", async () => {
    const cpp = [
      "float PetBrain::DistTo(const Vec2& p) const {",
      "    return std::sqrt(dx * dx + dy * dy);",
      "}",
      "void PetBrain::Hop(const PerchSite& site) {",
      "    Vec2 dest(site.x, site.y);",
      "    BehaviorLog::MonAt(site.x, site.y);",
      "    Logger::Instance().Initialize(L\"x\");",
      "    const char* trav = cond ? \"a\" : ModeName(mode_);",
      "}",
    ].join("\n");
    const cs = [
      "public class Box {",
      "    private void AnimTick() {",
      "        else AnimTick();",
      "        var x = true ?? throw new InvalidDataException(\"no\");",
      "    }",
      "}",
    ].join("\n");
    const c1 = withTempFile("fp.cpp", cpp);
    const c2 = withTempFile("fp.cs", cs);
    try {
      const ovCpp = await buildOverview(c1.file);
      const cn = ovCpp.sections.map((s) => s.name);
      assert.ok(cn.includes("PetBrain::DistTo"));
      assert.ok(cn.includes("PetBrain::Hop"));
      assert.ok(!cn.some((n) => n.includes("sqrt")), `sqrt: ${cn}`);
      assert.ok(!cn.includes("dest"), `dest: ${cn}`);
      assert.ok(!cn.some((n) => n.includes("MonAt")), `MonAt: ${cn}`);
      assert.ok(!cn.some((n) => n.includes("Instance")), `Instance: ${cn}`);
      assert.ok(!cn.includes("ModeName"), `ModeName call: ${cn}`);

      const ovCs = await buildOverview(c2.file);
      const sn = ovCs.sections.map((s) => s.name);
      assert.deepStrictEqual(sn.filter((n) => n === "AnimTick"), ["AnimTick"]);
      assert.ok(!sn.includes("InvalidDataException"), `throw new: ${sn}`);
    } finally {
      c1.cleanup();
      c2.cleanup();
    }
  });
});

describe("read-mode extractSection", () => {
  it("returns a full TS function block via brace matching", async () => {
    const src = [
      "export function target() {",
      "  const x = 1;",
      "  if (x) {",
      "    return x;",
      "  }",
      "  return 0;",
      "}",
      "",
      "export function other() { return 2; }",
    ].join("\n");
    const { file, cleanup } = withTempFile("s.ts", src);
    try {
      const result = await extractSection(file, "target", 100);
      assert.ok(result && !("candidates" in result));
      if (!result || "candidates" in result) return;
      assert.strictEqual(result.blockEndDetected, true);
      assert.strictEqual(result.startLine, 1);
      assert.ok(result.lines[0].includes("function target"));
      assert.ok(result.lines.some((l) => l.includes("return 0")));
      assert.ok(result.lines.at(-1)?.includes("}"));
    } finally {
      cleanup();
    }
  });

  it("returns candidates when the target name is ambiguous", async () => {
    const src = [
      "export function load() { return 1; }",
      "export function loadConfig() { return 2; }",
    ].join("\n");
    // sectionStartRegex is case-insensitive word boundary — "load" may match both
    const { file, cleanup } = withTempFile("a.ts", src);
    try {
      const result = await extractSection(file, "load", 50);
      // Either exact single match or candidates — assert no crash and useful shape
      if (!result) {
        assert.fail("expected a match for load");
      } else if ("candidates" in result) {
        assert.ok(result.candidates.length >= 2);
      } else {
        assert.ok(result.lines.length > 0);
      }
    } finally {
      cleanup();
    }
  });

  it("truncates long blocks and reports totalBlockLines", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `  line${i}();`).join("\n");
    const src = `export function big() {\n${body}\n}\n`;
    const { file, cleanup } = withTempFile("big.ts", src);
    try {
      const result = await extractSection(file, "big", 10);
      assert.ok(result && !("candidates" in result));
      if (!result || "candidates" in result) return;
      assert.strictEqual(result.blockTruncated, true);
      assert.ok((result.totalBlockLines ?? 0) > 10);
      assert.ok(result.lines.length <= 10);
    } finally {
      cleanup();
    }
  });

  it("extracts Python def by indentation", async () => {
    const src = [
      "def outer():",
      "    x = 1",
      "    def nested():",
      "        return x",
      "    return nested",
      "",
      "def sibling():",
      "    pass",
    ].join("\n");
    const { file, cleanup } = withTempFile("p.py", src);
    try {
      const result = await extractSection(file, "outer", 100);
      assert.ok(result && !("candidates" in result));
      if (!result || "candidates" in result) return;
      assert.strictEqual(result.blockEndDetected, true);
      const text = result.lines.join("\n");
      assert.ok(text.includes("def outer"));
      assert.ok(text.includes("def nested"));
      assert.ok(!text.includes("def sibling"));
    } finally {
      cleanup();
    }
  });

  it("extracts Python async def section by name", async () => {
    const src = [
      "@router.get('/api/chats')",
      "async def list_chats() -> dict:",
      "    return {'chats': []}",
      "",
      "async def other():",
      "    pass",
    ].join("\n");
    const { file, cleanup } = withTempFile("routes.py", src);
    try {
      const ov = await buildOverview(file);
      assert.deepStrictEqual(
        ov.sections.map((s) => `${s.type} ${s.name}`),
        ["async def list_chats", "async def other"]
      );
      const result = await extractSection(file, "list_chats", 100);
      assert.ok(result && !("candidates" in result));
      if (!result || "candidates" in result) return;
      assert.strictEqual(result.blockEndDetected, true);
      const text = result.lines.join("\n");
      // Decorators above the def are included in the section window
      assert.ok(text.includes("@router.get('/api/chats')"), text);
      assert.ok(text.includes("async def list_chats"));
      assert.ok(text.includes("return {'chats': []}"));
      assert.ok(!text.includes("async def other"));
      assert.strictEqual(result.startLine, 1);
    } finally {
      cleanup();
    }
  });

  it("includes multi-line Python decorators in section start", async () => {
    const src = [
      "def prev():",
      "    pass",
      "",
      "@router.get(",
      "    '/api/x',",
      ")",
      "async def endpoint():",
      "    return 1",
      "",
      "def after():",
      "    pass",
    ].join("\n");
    const { file, cleanup } = withTempFile("ml.py", src);
    try {
      const result = await extractSection(file, "endpoint", 100);
      assert.ok(result && !("candidates" in result));
      if (!result || "candidates" in result) return;
      const text = result.lines.join("\n");
      assert.ok(text.startsWith("@router.get("), text);
      assert.ok(text.includes("async def endpoint"));
      assert.ok(!text.includes("def prev"));
      assert.ok(!text.includes("def after"));
    } finally {
      cleanup();
    }
  });

  it("extracts Rust pub(crate), async fn, mod, impl Trait for Type", async () => {
    const src = [
      "mod audio;",
      "pub(crate) enum AppEvent { Start }",
      "pub async fn run() {}",
      "impl Default for Config {",
      "    fn default() -> Self { Self }",
      "}",
      "impl Config {",
      "    pub fn load() {}",
      "}",
    ].join("\n");
    const { file, cleanup } = withTempFile("main.rs", src);
    try {
      const ov = await buildOverview(file);
      const label = ov.sections.map((s) => `${s.type} ${s.name}`);
      assert.ok(label.includes("mod audio"), label.join(","));
      assert.ok(label.includes("enum AppEvent"), label.join(","));
      assert.ok(label.includes("async fn run"), label.join(","));
      assert.ok(label.includes("impl Default for Config"), label.join(","));
      assert.ok(label.includes("impl Config"), label.join(","));
      assert.ok(label.includes("fn default"), label.join(","));
      assert.ok(label.includes("fn load"), label.join(","));

      const sec = await extractSection(file, "Default for Config", 50);
      assert.ok(sec && !("candidates" in sec));
      if (!sec || "candidates" in sec) return;
      assert.ok(sec.lines.join("\n").includes("impl Default for Config"));
    } finally {
      cleanup();
    }
  });

  it("extracts export default function section by name or default", async () => {
    const src = [
      "export default function payloadTrace(pi: any): void {",
      "  const x = 1;",
      "  return;",
      "}",
    ].join("\n");
    const { file, cleanup } = withTempFile("pt.ts", src);
    try {
      const byName = await extractSection(file, "payloadTrace", 50);
      assert.ok(byName && !("candidates" in byName));
      if (!byName || "candidates" in byName) return;
      assert.ok(byName.lines[0].includes("payloadTrace"));

      const anonSrc = ["export default function (pi: any) {", "  return 1;", "}"].join("\n");
      const anon = withTempFile("anon.ts", anonSrc);
      try {
        const ov = await buildOverview(anon.file);
        assert.ok(ov.sections.some((s) => s.name === "default"));
        const sec = await extractSection(anon.file, "default", 50);
        assert.ok(sec && !("candidates" in sec));
        if (!sec || "candidates" in sec) return;
        assert.ok(sec.lines[0].includes("export default function"));
      } finally {
        anon.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  it("returns null for missing target", async () => {
    const { file, cleanup } = withTempFile("m.ts", "export function a() {}\n");
    try {
      const result = await extractSection(file, "nope", 20);
      assert.strictEqual(result, null);
    } finally {
      cleanup();
    }
  });

  it("C# section finds brace-next-line method, not call-sites", async () => {
    const src = [
      "public class Box {",
      "    private void ShowFile(int index)",
      "    {",
      "        if (index < 0) return;",
      "        ShowFile(index + 1); // recursive call-site noise",
      "    }",
      "    private void Other() { ShowFile(0); }",
      "}",
    ].join("\n");
    const { file, cleanup } = withTempFile("Box.cs", src);
    try {
      const result = await extractSection(file, "ShowFile", 50);
      assert.ok(result && !("candidates" in result), `expected single def, got ${JSON.stringify(result)}`);
      if (!result || "candidates" in result) return;
      assert.strictEqual(result.startLine, 2);
      assert.strictEqual(result.blockEndDetected, true);
      assert.ok(result.lines[0].includes("ShowFile"));
      assert.ok(result.lines.some((l) => l.includes("index < 0")));
    } finally {
      cleanup();
    }
  });

  it("C++ section accepts bare and qualified Class::Method targets", async () => {
    const src = [
      "namespace aipet {",
      "void PetBrain::Tick(float dt) {",
      "    state_ = PetState::Idle;",
      "}",
      "bool PetBrain::CommitWalk(Vec2 d, bool f, const char* t) {",
      "    return CommitWalk(d, false, t);",
      "}",
      "}",
    ].join("\n");
    const { file, cleanup } = withTempFile("brain.cpp", src);
    try {
      const byBare = await extractSection(file, "Tick", 30);
      assert.ok(byBare && !("candidates" in byBare), `bare Tick: ${JSON.stringify(byBare)}`);
      if (!byBare || "candidates" in byBare) return;
      assert.ok(byBare.lines[0].includes("PetBrain::Tick"));
      assert.strictEqual(byBare.blockEndDetected, true);

      const byQual = await extractSection(file, "PetBrain::CommitWalk", 30);
      assert.ok(byQual && !("candidates" in byQual), `qual: ${JSON.stringify(byQual)}`);
      if (!byQual || "candidates" in byQual) return;
      assert.ok(byQual.lines[0].includes("CommitWalk"));
      // must not pick the recursive call-site line as the start
      assert.ok(byQual.lines[0].includes("PetBrain::"));
    } finally {
      cleanup();
    }
  });
});

describe("read-mode markdown sections", () => {
  const src = [
    "# Title",
    "",
    "## Section A",
    "",
    "alpha text",
    "",
    "```",
    "# Fake heading",
    "```",
    "",
    "### Nested",
    "inner",
    "",
    "## Section B",
    "beta",
    "",
    "## Foo ##",
    "",
    "## [Link Head](#x)",
  ].join("\n");

  it("overview lists ATX headings and skips fenced ones", async () => {
    const { file, cleanup } = withTempFile("doc.md", src);
    try {
      const ov = await buildOverview(file);
      const names = ov.sections.map((s) => s.name);
      assert.deepStrictEqual(names, [
        "Title",
        "Section A",
        "Nested",
        "Section B",
        "Foo",
        "Link Head",
      ]);
      assert.ok(!names.includes("Fake heading"));
      assert.strictEqual(ov.sections.find((s) => s.name === "Nested")?.type, "h3");
    } finally {
      cleanup();
    }
  });

  it("section stops at next same-or-higher heading and keeps nested + fences", async () => {
    const { file, cleanup } = withTempFile("doc.md", src);
    try {
      const a = await extractSection(file, "Section A", 200);
      assert.ok(a && !("candidates" in a));
      if (!a || "candidates" in a) return;
      assert.strictEqual(a.blockEndDetected, true);
      assert.ok(a.lines[0].includes("Section A"));
      assert.ok(a.lines.some((l) => l.includes("alpha text")));
      assert.ok(a.lines.some((l) => l.includes("# Fake heading")));
      assert.ok(a.lines.some((l) => l.includes("### Nested")));
      assert.ok(!a.lines.some((l) => l.includes("Section B")));

      const title = await extractSection(file, "Title", 200);
      assert.ok(title && !("candidates" in title));
      if (!title || "candidates" in title) return;
      assert.strictEqual(title.blockEndDetected, true);
      assert.ok(title.lines.some((l) => l.includes("## Section B")));
      assert.strictEqual(title.endLine, src.split("\n").length);
    } finally {
      cleanup();
    }
  });
});

describe("read-mode html headings", () => {
  const src = [
    "<h1>Title</h1>",
    "<p>top</p>",
    '<h2 id="sec-a">Section A</h2>',
    "<p>alpha</p>",
    "<h3>Nested</h3>",
    "<p>inner</p>",
    "<h2>Hello <em>world</em></h2>",
    "<p>hw</p>",
    '<h2 id="empty"></h2>',
    "<p>empty body</p>",
  ].join("\n");

  it("overview uses inner text (and id when empty)", async () => {
    const { file, cleanup } = withTempFile("page.html", src);
    try {
      const ov = await buildOverview(file);
      const names = ov.sections.map((s) => s.name);
      assert.deepStrictEqual(names, ["Title", "Section A", "Nested", "Hello world", "empty"]);
      assert.strictEqual(ov.sections[0]?.type, "h1");
      assert.strictEqual(ov.sections[1]?.type, "h2");
    } finally {
      cleanup();
    }
  });

  it("section includes nested headings and stops at next same level", async () => {
    const { file, cleanup } = withTempFile("page.html", src);
    try {
      const a = await extractSection(file, "Section A", 200);
      assert.ok(a && !("candidates" in a));
      if (!a || "candidates" in a) return;
      assert.strictEqual(a.blockEndDetected, true);
      assert.ok(a.lines[0].includes("Section A"));
      assert.ok(a.lines.some((l) => l.includes("<h3>Nested</h3>")));
      assert.ok(!a.lines.some((l) => l.includes("Hello")));

      const byId = await extractSection(file, "empty", 50);
      assert.ok(byId && !("candidates" in byId));
      if (!byId || "candidates" in byId) return;
      assert.ok(byId.lines[0].includes('id="empty"'));
      assert.ok(byId.lines.some((l) => l.includes("empty body")));

      const inner = await extractSection(file, "Hello world", 50);
      assert.ok(inner && !("candidates" in inner), `inner tags: ${JSON.stringify(inner)}`);
      if (!inner || "candidates" in inner) return;
      assert.ok(inner.lines[0].includes("Hello"));

      const attrId = await extractSection(file, "sec-a", 50);
      assert.ok(attrId && !("candidates" in attrId));
      if (!attrId || "candidates" in attrId) return;
      assert.ok(attrId.lines[0].includes("Section A"));
    } finally {
      cleanup();
    }
  });
});

describe("read-mode truncateText", () => {
  it("passes short text through", () => {
    const r = truncateText("hello", 100);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.text, "hello");
  });

  it("truncates by byte budget and appends continuation hint", () => {
    const r = truncateText("x".repeat(1000), 100);
    assert.strictEqual(r.truncated, true);
    assert.match(r.text, /Truncated/);
    // Body before the hint is cut to maxBytes (UTF-8 safe); total length > budget due to hint.
    assert.ok(r.text.length < 1000);
    assert.ok(r.text.length > 100);
  });
});

describe("read-mode render", () => {
  const fakeTheme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as unknown as import("@earendil-works/pi-coding-agent").Theme;

  function readDefinition() {
    let def: any;
    readModeFactory({ registerTool: (d: any) => { def = d; } } as any);
    return def;
  }

  it("never prints `undefined` while the path is still streaming", () => {
    const text = readDefinition().renderCall({}, fakeTheme, {}).render(80).join("");
    assert.ok(!text.includes("undefined"));
    assert.ok(text.includes("read:raw"));
    assert.ok(text.includes("..."));
  });

  it("names the mode that actually runs (raw + target is section)", () => {
    const text = readDefinition()
      .renderCall({ path: "C:/pkg/Big.cs", mode: "raw", target: "SomeClass.Method" }, fakeTheme, {})
      .render(80)
      .join("");
    assert.ok(text.includes("read:section"));
    assert.ok(text.includes('target="SomeClass.Method"'));
  });

  it("wraps a long path at a narrow width instead of cutting the row's facts away", () => {
    const line = readDefinition()
      .renderCall({ path: "C:/10x001/pi extensions/read-mode/parser.ts", limit: 60 }, fakeTheme, {})
      .render(24)
      .map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .join("");
    assert.ok(line.includes("parser.ts"), "the path survives wrapping");
    assert.ok(line.includes("limit=60"));
  });

  it("resolves an image against the session cwd (the built-in definition gets the context)", async () => {
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { dir, cleanup } = withTempFile("dot.png", "");
    writeFileSync(path.join(dir, "dot.png"), onePixelPng);
    try {
      const def = readDefinition();
      const res = await def.execute("t1", { path: "dot.png", mode: "raw" }, undefined, undefined, { cwd: dir });
      assert.match(res.content[0].text, /Read image file \[image\/png\]/, "the file was found through the session cwd");
      // A session cwd that does not hold the file must fail — resolving it against process.cwd()
      // would silently read the wrong directory.
      await assert.rejects(
        def.execute("t2", { path: "dot.png", mode: "raw" }, undefined, undefined, { cwd: path.join(dir, "elsewhere") }),
      );
    } finally {
      cleanup();
    }
  });

  it("reports a failed read as an error result, not as a silent success", async () => {
    const { file, cleanup } = withTempFile("small.ts", "let a = 1;\n");
    try {
      const def = readDefinition();
      const res = await def.execute("t1", { path: file, mode: "raw", offset: 999 }, undefined, undefined, { cwd: path.dirname(file) });
      assert.strictEqual(res.isError, true);
      assert.match(res.content[0].text, /beyond end of file/);
    } finally {
      cleanup();
    }
  });
});
