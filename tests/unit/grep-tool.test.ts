import assert from "node:assert";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import grepFactory from "../../grep-tool/index.js";

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

import {
  BROAD_CONTENT_THRESHOLD,
  BROAD_CONTEXT_THRESHOLD,
  DEFAULT_HEAD_LIMIT,
  MAX_LINE_LENGTH,
  broadThreshold,
  isRegexError,
  isEnvFilePath,
  parseRgCountStdout,
  shouldRunBroadPreflight,
  toAbsoluteAgentPath,
  truncateLine,
} from "../../grep-tool/helpers.js";

describe("grep-tool toAbsoluteAgentPath", () => {
  const cwd = "C:\\10x001\\project";

  it("returns cwd when path omitted", () => {
    assert.strictEqual(toAbsoluteAgentPath(undefined, cwd), cwd);
  });

  it("strips surrounding quotes", () => {
    const p = toAbsoluteAgentPath('"src/app.ts"', cwd);
    assert.strictEqual(p, path.resolve(cwd, "src/app.ts"));
  });

  it("converts Git Bash /c/... paths to drive letters", () => {
    const p = toAbsoluteAgentPath("/c/10x001/project/src", cwd);
    // On Windows path.resolve may normalize separators.
    assert.match(p.replace(/\\/g, "/"), /C:\/10x001\/project\/src/i);
  });

  it("resolves relative paths against cwd", () => {
    assert.strictEqual(
      toAbsoluteAgentPath("foo/bar.ts", cwd),
      path.resolve(cwd, "foo/bar.ts"),
    );
  });
});

describe("grep-tool broad preflight policy", () => {
  it("runs for content mode without allow_broad and default limit", () => {
    assert.strictEqual(
      shouldRunBroadPreflight({ mode: "content", hasContext: false }),
      true,
    );
  });

  it("skips non-content modes", () => {
    assert.strictEqual(
      shouldRunBroadPreflight({ mode: "files_with_matches", hasContext: false }),
      false,
    );
    assert.strictEqual(
      shouldRunBroadPreflight({ mode: "count_matches", hasContext: false }),
      false,
    );
  });

  it("skips when allow_broad is set", () => {
    assert.strictEqual(
      shouldRunBroadPreflight({ mode: "content", allowBroad: true, hasContext: false }),
      false,
    );
  });

  it("skips when head_limit is already at/below threshold", () => {
    assert.strictEqual(
      shouldRunBroadPreflight({
        mode: "content",
        headLimit: BROAD_CONTENT_THRESHOLD,
        hasContext: false,
      }),
      false,
    );
    assert.strictEqual(
      shouldRunBroadPreflight({
        mode: "content",
        headLimit: BROAD_CONTENT_THRESHOLD + 1,
        hasContext: false,
      }),
      true,
    );
  });

  it("uses lower threshold when context flags are present", () => {
    assert.strictEqual(broadThreshold(false), BROAD_CONTENT_THRESHOLD);
    assert.strictEqual(broadThreshold(true), BROAD_CONTEXT_THRESHOLD);
    assert.strictEqual(
      shouldRunBroadPreflight({
        mode: "content",
        headLimit: BROAD_CONTEXT_THRESHOLD + 1,
        hasContext: true,
      }),
      true,
    );
    assert.strictEqual(
      shouldRunBroadPreflight({
        mode: "content",
        headLimit: BROAD_CONTEXT_THRESHOLD,
        hasContext: true,
      }),
      false,
    );
  });

  it("DEFAULT_HEAD_LIMIT stays above content threshold", () => {
    assert.ok(DEFAULT_HEAD_LIMIT > BROAD_CONTENT_THRESHOLD);
  });
});

describe("grep-tool parseRgCountStdout", () => {
  it("sums per-file counts", () => {
    const { count, files } = parseRgCountStdout(
      ["src/a.ts:3", "src/b.ts:7", ""].join("\n"),
    );
    assert.strictEqual(count, 10);
    assert.strictEqual(files, 2);
  });

  it("handles Windows paths with drive-letter colons", () => {
    // Split at last colon so C:\foo:12 still works.
    const { count, files } = parseRgCountStdout("C:\\10x001\\pi extensions\\a.ts:4\n");
    assert.strictEqual(count, 4);
    assert.strictEqual(files, 1);
  });

  it("ignores non-count lines", () => {
    const { count, files } = parseRgCountStdout("not a count line\n");
    assert.strictEqual(count, 0);
    assert.strictEqual(files, 0);
  });

  it("drops a bare count — single-file rg -c without --with-filename", () => {
    const { count, files } = parseRgCountStdout("400\n");
    assert.strictEqual(count, 0);
    assert.strictEqual(files, 0);
  });
});

describe("grep-tool env path exclusion", () => {
  it("matches .env and .env.* only", () => {
    assert.strictEqual(isEnvFilePath("C:/proj/.env"), true);
    assert.strictEqual(isEnvFilePath("C:/proj/.env.local"), true);
    assert.strictEqual(isEnvFilePath("C:/proj/.ENV"), true);
    assert.strictEqual(isEnvFilePath("C:/proj/.environment"), false);
    assert.strictEqual(isEnvFilePath("C:/proj/env"), false);
    assert.strictEqual(isEnvFilePath("C:/proj"), false);
  });
});

describe("grep-tool truncateLine / isRegexError", () => {
  it("truncates long lines with marker", () => {
    const long = "a".repeat(MAX_LINE_LENGTH + 20);
    const out = truncateLine(long);
    assert.ok(out.endsWith(" [...truncated]"));
    assert.ok(out.length < long.length);
  });

  it("detects ripgrep regex parse errors", () => {
    assert.ok(isRegexError("regex parse error: unclosed group"));
    assert.ok(isRegexError("Error parsing regex"));
    assert.ok(!isRegexError("no matches found"));
  });
});

describe("grep-tool render and error flag", () => {
  const fakeTheme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as unknown as import("@earendil-works/pi-coding-agent").Theme;

  function grepDefinition() {
    let def: any;
    grepFactory({ registerTool: (d: any) => { def = d; } } as any);
    return def;
  }

  it("never prints `undefined` while the pattern is still streaming", () => {
    const text = grepDefinition().renderCall({}, fakeTheme, {}).render(80).join("");
    assert.ok(!text.includes("undefined"));
    assert.ok(text.startsWith("grep"));
    assert.ok(text.includes("..."));
  });

  it("flags a refused call as an error result", async () => {
    const res = await grepDefinition().execute("t1", { pattern: "x", path: ".env" }, undefined, undefined, {});
    assert.strictEqual(res.isError, true);
    assert.match(res.content[0].text, /Refused/);
  });

  it("reports a capped result with the field the inherited body prints", { skip: !hasRipgrep() }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grep-tool-row-"));
    try {
      writeFileSync(path.join(dir, "hits.txt"), Array.from({ length: 12 }, (_, i) => `hit ${i}`).join("\n") + "\n", "utf-8");
      const res = await grepDefinition().execute("t1", { pattern: "hit", path: dir, allow_broad: true, head_limit: 5 }, undefined, undefined, {});
      assert.strictEqual(res.details.matchLimitReached, 5);
      assert.strictEqual(res.details.truncated, true);
      assert.strictEqual(res.isError, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
