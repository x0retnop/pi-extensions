import assert from "node:assert";
import { describe, it, after } from "node:test";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { formatDuration } from "../../common/duration.js";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function pathToFileURL(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (normalized.startsWith("/") ? normalized.slice(1) : normalized);
}

const settingsModule = await import(
  pathToFileURL(path.join(root, "pi-agent-run", "settings.js"))
);
const highlighterModule = await import(
  pathToFileURL(path.join(root, "pi-agent-run", "highlighter.js"))
);
const timerModule = await import(
  pathToFileURL(path.join(root, "pi-agent-run", "timer.js"))
);
const renderModule = await import(
  pathToFileURL(path.join(root, "pi-agent-run", "render.js"))
);
const runModule = await import(
  pathToFileURL(path.join(root, "pi-agent-run", "run.js"))
);
const guardModule = await import(
  pathToFileURL(path.join(root, "pi-agent-run", "output-guard.js"))
);

const {
  createRuntimeSettings,
  updateSettings,
  clampPreviewLines,
  normalizeMode,
} = settingsModule;
const { highlightCodeSafe } = highlighterModule;
const {
  visibleElapsedMs,
  syncRunTimer,
  TIMER_VISIBLE_THRESHOLD_MS,
} = timerModule;
const {
  formatCodeBody,
  formatCodeCall,
  formatCodeResultLines,
  PREVIEW_LINE_WIDTH,
} = renderModule;
const {
  resolveTimeoutMs,
  encodePwshCommand,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_MS,
  trackSpillPath,
  drainSpillPaths,
  runCommand,
  formatResult,
} = runModule;

const { guardOutput, cleanupOutputPath, DEFAULT_MAX_BYTES } = guardModule;

describe("pi-agent-run settings", () => {
  it("createRuntimeSettings returns mutable object independent of defaults", () => {
    const a = createRuntimeSettings();
    const b = createRuntimeSettings();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.pwsh, b.pwsh);
    a.pwsh.previewLines = 99;
    assert.notStrictEqual(a.pwsh.previewLines, b.pwsh.previewLines);
  });

  it("clampPreviewLines clamps to 1-50", () => {
    assert.strictEqual(clampPreviewLines(0), 1);
    assert.strictEqual(clampPreviewLines(-5), 1);
    assert.strictEqual(clampPreviewLines(1), 1);
    assert.strictEqual(clampPreviewLines(50), 50);
    assert.strictEqual(clampPreviewLines(51), 50);
    assert.strictEqual(clampPreviewLines(8.7), 8);
  });

  it("normalizeMode falls back to auto", () => {
    assert.strictEqual(normalizeMode("powershell"), "powershell");
    assert.strictEqual(normalizeMode("python"), "python");
    assert.strictEqual(normalizeMode("none"), "none");
    assert.strictEqual(normalizeMode("auto"), "auto");
    assert.strictEqual(normalizeMode("unknown"), "auto");
    assert.strictEqual(normalizeMode(123), "auto");
  });

  it("updateSettings mutates in place and persists", () => {
    const settings = createRuntimeSettings();
    updateSettings(settings, "pwsh", { previewLines: 15 });
    assert.strictEqual(settings.pwsh.previewLines, 15);
    updateSettings(settings, "py", { highlightMode: "none" });
    assert.strictEqual(settings.py.highlightMode, "none");
  });
});

describe("pi-agent-run highlighter", () => {
  const fakeTheme = {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
    fgColors: {
      toolOutput: "",
      muted: "",
      toolTitle: "",
      syntaxString: "",
      syntaxVariable: "",
      syntaxNumber: "",
      syntaxKeyword: "",
      syntaxFunction: "",
      syntaxOperator: "",
      syntaxType: "",
      syntaxPunctuation: "",
      syntaxComment: "",
    },
  } as unknown as import("@earendil-works/pi-coding-agent").Theme;

  it("renders plain output when highlight disabled", () => {
    const lines = highlightCodeSafe("Get-Process", "none", fakeTheme, "pwsh");
    assert.strictEqual(lines.length, 1);
    assert(lines[0].includes("Get-Process"));
  });

  it("auto resolves to tool-specific language", () => {
    const ps = highlightCodeSafe("$x = 1", "auto", fakeTheme, "pwsh")[0];
    assert(ps.includes("syntaxVariable"));
  });

  it("handles single-quoted strings with escaped quotes", () => {
    const line = "Write-Host 'it''s working'";
    const highlighted = highlightCodeSafe(
      line,
      "powershell",
      fakeTheme,
      "pwsh",
    )[0];
    assert(highlighted.includes("[syntaxString]"));
    assert(highlighted.includes("it''s working"));
  });

  it("handles double-quoted strings with backtick escapes", () => {
    const line = 'Write-Host "quote: `""';
    const highlighted = highlightCodeSafe(
      line,
      "powershell",
      fakeTheme,
      "pwsh",
    )[0];
    assert(highlighted.includes("[syntaxString]"));
  });

  it("colors cmdlets and keywords", () => {
    const line = highlightCodeSafe(
      "if ($true) { Get-Process }",
      "powershell",
      fakeTheme,
      "pwsh",
    )[0];
    assert(line.includes("[syntaxKeyword]if"));
    assert(line.includes("[syntaxFunction]Get-Process"));
  });
});

describe("pi-agent-run timer", () => {
  it("formatDuration formats seconds/minutes/hours", () => {
    assert.strictEqual(formatDuration(500), "0.5s");
    assert.strictEqual(formatDuration(1500), "1s");
    assert.strictEqual(formatDuration(65_000), "1m 05s");
    assert.strictEqual(formatDuration(300_000), "5m");
    assert.strictEqual(formatDuration(3_661_000), "1h 01m 01s");
  });

  it("visibleElapsedMs hides under threshold", () => {
    const now = 100_000;
    assert.strictEqual(
      visibleElapsedMs(now - 1000, { running: true, now }),
      undefined,
    );
    assert.strictEqual(
      visibleElapsedMs(now - TIMER_VISIBLE_THRESHOLD_MS, { running: true, now }),
      TIMER_VISIBLE_THRESHOLD_MS,
    );
    assert.strictEqual(
      visibleElapsedMs(now - 10_000, { running: false, now }),
      undefined,
    );
  });

  it("syncRunTimer: hidden under the threshold, frozen after the row settles", () => {
    const state: { startedAt?: number; endedAt?: number; interval?: unknown } = {};
    const t0 = 1_000_000;

    // running, 2 s in → below the threshold, nothing shown, interval installed
    assert.strictEqual(
      syncRunTimer(state, { executionStarted: true, isPartial: true, invalidate: () => {}, now: t0 }),
      undefined,
    );
    assert.ok(state.interval !== undefined);
    assert.strictEqual(
      syncRunTimer(state, { executionStarted: true, isPartial: true, invalidate: () => {}, now: t0 + 12_000 }),
      12_000,
    );

    // settled → the interval stops and the value stays (the old module map dropped state here)
    assert.strictEqual(
      syncRunTimer(state, { executionStarted: true, isPartial: false, invalidate: () => {}, now: t0 + 12_400 }),
      12_400,
    );
    assert.strictEqual(state.interval, undefined);
    assert.strictEqual(
      syncRunTimer(state, { executionStarted: true, isPartial: false, invalidate: () => {}, now: t0 + 900_000 }),
      12_400,
    );
    if (state.interval) clearInterval(state.interval as NodeJS.Timeout);
  });

  it("syncRunTimer: a short command stays clean, a denied call shows nothing", () => {
    const short: { startedAt?: number; endedAt?: number } = {};
    syncRunTimer(short, { executionStarted: true, isPartial: true, invalidate: () => {}, now: 0 });
    assert.strictEqual(
      syncRunTimer(short, { executionStarted: true, isPartial: false, invalidate: () => {}, now: 400 }),
      undefined,
    );

    const denied: { startedAt?: number; endedAt?: number } = {};
    assert.strictEqual(
      syncRunTimer(denied, { executionStarted: false, isPartial: false, invalidate: () => {} }),
      undefined,
    );
    assert.strictEqual(denied.startedAt, undefined);
    assert.strictEqual(denied.endedAt, undefined);
  });
});

describe("pi-agent-run render", () => {
  const fakeTheme = {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => `*${text}*`,
  } as unknown as import("@earendil-works/pi-coding-agent").Theme;

  const toolSettings = {
    previewLines: 3,
    highlight: false,
    highlightMode: "none" as const,
  };

  it("formatCodeBody collapses long blocks", () => {
    const code = ["a", "b", "c", "d", "e"].join("\n");
    const lines = formatCodeBody(code, toolSettings, fakeTheme, "pwsh");
    assert.strictEqual(lines.length, 4); // 3 + suffix
    assert(lines[3].includes("+2"));
  });

  it("formatCodeCall includes title and optional timer", () => {
    const text = formatCodeCall(
      "pwsh",
      "Get-Date",
      toolSettings,
      30,
      fakeTheme,
      12_000,
    );
    assert(text.includes("pwsh>"));
    assert(text.includes("timeout 30s"));
    assert(text.includes("12s"));
    assert(text.includes("Get-Date"));
  });

  it("expanded lifts the line cap and the 120-column clip", () => {
    const long = `Get-ChildItem -Path C:/10x001 -Recurse -Filter *.ts | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-3) } | Select-Object -ExpandProperty FullName`;
    assert.ok(long.length > PREVIEW_LINE_WIDTH);

    const collapsed = formatCodeCall("pwsh", long, toolSettings, undefined, fakeTheme);
    assert(collapsed.includes("..."), "collapsed clips the line at PREVIEW_LINE_WIDTH");
    assert(!collapsed.includes("AddDays(-3)"), "the tail of a long line is collapsed away");

    const expanded = formatCodeCall("pwsh", long, toolSettings, undefined, fakeTheme, undefined, {
      expanded: true,
    });
    assert(expanded.includes("AddDays(-3)"));
    assert.ok(!expanded.includes("..."), "no clip mark and no cap suffix when expanded");

    const many = Array.from({ length: 10 }, (_, i) => `Write-Host "line${i}"`).join("\n");
    assert.strictEqual(formatCodeBody(many, toolSettings, fakeTheme, "pwsh").length, 4); // 3 + suffix
    assert.strictEqual(
      formatCodeBody(many, toolSettings, fakeTheme, "pwsh", { expanded: true }).length,
      10,
    );
  });

  it("formatCodeResultLines keeps the tail — the guard summary stays visible", () => {
    const output = [
      ...Array.from({ length: 12 }, (_, i) => `log line ${i}`),
      "[Showing lines 289-300 of 300 (2.4KB of 24.0KB). Full output: C:/tmp/full-output.log. Hint: filter the output in your script.]",
    ].join("\n");

    const collapsed = formatCodeResultLines(output, toolSettings, fakeTheme);
    assert.strictEqual(collapsed.length, 5); // blank + 3 kept lines + hint
    assert.ok(collapsed[1].includes("log line 10"));
    assert.ok(collapsed[3].includes("Full output: C:/tmp/full-output.log"));
    assert.ok(collapsed[4].includes("10 earlier lines"));

    const expanded = formatCodeResultLines(output, toolSettings, fakeTheme, { expanded: true });
    assert.strictEqual(expanded.length, 14); // blank + every line
    assert.ok(expanded[1].includes("log line 0"));
    assert.strictEqual(formatCodeResultLines("   \n", toolSettings, fakeTheme).length, 0);
  });

  // The row draws inside Pi's Box, whose background is one wrap around the line (theme.bg). A child's
  // own SGR resets it mid-line ("black half-filled row"), and `Text` → wrapTextWithAnsi splits on /r
  // as well, so a CRLF line produced a stray empty row. Pi's built-in body strips both (getTextOutput).
  it("formatCodeResultLines strips the child's own styling, controls and CR", () => {
    const raw =
      "\x1b[32;1mProcessId       : \x1b[0m6040\r\n" +
      "\x1b[32;1mName            : \x1b[0mpythonw.exe\r\n" +
      "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\r\n" +
      "tab\tkept\x07\r\n";

    const lines = formatCodeResultLines(raw, toolSettings, fakeTheme, { expanded: true });
    const joined = lines.join("\n");

    assert.ok(!joined.includes("\x1b"), "no escape sequence may reach the row");
    assert.ok(!joined.includes("\r"), "no CR: wrapTextWithAnsi would split the line a second time");
    assert.ok(!joined.includes("\x07"), "no stray control char");
    assert.strictEqual(lines.length, 5); // blank + 4 lines, no phantom row per CRLF
    assert.strictEqual(lines[1], "[toolOutput]ProcessId       : 6040[/toolOutput]");
    assert.strictEqual(lines[3], "[toolOutput]link[/toolOutput]");
    assert.strictEqual(lines[4], "[toolOutput]tab\tkept[/toolOutput]");
  });
});

describe("pi-agent-run run command", { skip: process.platform !== "win32" }, () => {
  it("times out a long pwsh sleep", async () => {
    const start = Date.now();
    const result = await runCommand("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Sleep -Seconds 10",
    ], { timeoutMs: 500 });
    assert.strictEqual(result.timedOut, true);
    assert.ok(Date.now() - start < 2000);
  });

  it("names the timeout in human units", async () => {
    await assert.rejects(
      () =>
        formatResult(
          { stdout: "", stderr: "", exitCode: 124, timedOut: true },
          undefined,
          300,
        ),
      /Command timed out after 5m/,
    );
  });

  it("times out a pwsh command that spawns a child process", async () => {
    const start = Date.now();
    const result = await runCommand("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'node -e "setInterval(()=>{},1000)"',
    ], { timeoutMs: 500 });
    assert.strictEqual(result.timedOut, true);
    assert.ok(Date.now() - start < 2000);
  });

  it("cancels promptly when aborted", async () => {
    const controller = new AbortController();
    const promise = runCommand("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Sleep -Seconds 10",
    ], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, /cancelled/i);
  });
});

describe("pi-agent-run run helpers", () => {
  it("resolveTimeoutMs defaults and disables", () => {
    assert.strictEqual(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_SEC * 1000);
    assert.strictEqual(resolveTimeoutMs(0), undefined);
    assert.strictEqual(resolveTimeoutMs(10), 10_000);
    assert.throws(() => resolveTimeoutMs(-1));
    assert.throws(() => resolveTimeoutMs(MAX_TIMEOUT_MS / 1000 + 1));
  });

  it("encodePwshCommand base64-encodes bootstrap + code", () => {
    const profile = "C:\\agent\\profile.ps1";
    const b64 = encodePwshCommand("Write-Host hi", profile);
    const decoded = Buffer.from(b64, "base64").toString("utf16le");
    assert(decoded.includes("profile.ps1"));
    assert(decoded.includes("Write-Host hi"));
    assert(decoded.includes("Test-Path -LiteralPath"));
  });

  it("encodePwshCommand escapes single quotes in profile path", () => {
    const profile = "C:\\o'Brien\\profile.ps1";
    const b64 = encodePwshCommand("1", profile);
    const decoded = Buffer.from(b64, "base64").toString("utf16le");
    assert(decoded.includes("o''Brien"));
  });
});

describe("pi-agent-run output guard", () => {
  it("passes small output through", async () => {
    const r = await guardOutput("hello\nworld");
    assert.strictEqual(r.text, "hello\nworld");
    assert.strictEqual(r.details.truncated, false);
  });

  it("truncates large output and writes spill file", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line-${i} ${"x".repeat(80)}`).join(
      "\n",
    );
    const r = await guardOutput(big, {
      maxBytes: 2048,
      maxLines: 20,
      tempFilePrefix: "pi-agent-run-test",
    });
    assert.strictEqual(r.details.truncated, true);
    assert.ok(r.details.fullOutputPath);
    assert.ok(fs.existsSync(r.details.fullOutputPath!));
    assert(r.text.includes("Full output:"));
    await cleanupOutputPath(r.details.fullOutputPath);
    assert.ok(!fs.existsSync(r.details.fullOutputPath!));
  });

  it("respects default max bytes constant", () => {
    assert.strictEqual(DEFAULT_MAX_BYTES, 10 * 1024);
  });

  it("drainSpillPaths cleans tracked files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-run-spill-"));
    const file = path.join(dir, "full-output.log");
    fs.writeFileSync(file, "data");
    trackSpillPath(file);
    await drainSpillPaths();
    assert.ok(!fs.existsSync(file));
  });

  it("puts the exit code in the text the model sees", async () => {
    const ok = await formatResult(
      { exitCode: 0, stdout: "ok", stderr: "", timedOut: false },
      undefined,
    );
    assert.strictEqual(ok.content[0].type === "text" ? ok.content[0].text : "", "ok\nexit: 0");

    const soft = await formatResult(
      { exitCode: 1, stdout: "nope", stderr: "", timedOut: false },
      undefined,
      undefined,
      false,
    );
    assert.strictEqual(soft.content[0].type === "text" ? soft.content[0].text : "", "nope\nexit: 1");

    const empty = await formatResult(
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      undefined,
    );
    assert.strictEqual(empty.content[0].type === "text" ? empty.content[0].text : "", "(no output)\nexit: 0");
  });

  it("includes exit: N when a non-zero code throws", async () => {
    await assert.rejects(
      () => formatResult(
        { exitCode: 3, stdout: "x", stderr: "", timedOut: false },
        undefined,
      ),
      (err: Error) => err.message.includes("exit: 3") && err.message.includes("Command exited with code 3"),
    );
  });
});
