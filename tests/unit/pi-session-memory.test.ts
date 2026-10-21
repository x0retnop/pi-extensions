import { test } from "node:test";
import assert from "node:assert";
import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  extractProject,
  extractProjectFromSessionFile,
  isDifferentProject,
  normalizeProjectPath,
} from "../../pi-session-memory/project.js";
import {
  exportSessionToMarkdown,
  makeExportFileName,
} from "../../pi-session-memory/local-export.js";
import {
  buildChatPreview,
  encodeSessionDirName,
  hasChildSessionDirs,
  listScopedSessions,
  listSessionProjects,
  nextSessionScope,
  readSessionMeta,
  sessionDirMatchesScope,
} from "../../pi-session-memory/local-sessions.js";
import {
  parseAnnotationReply,
  readSessionNote,
  writeSessionNote,
} from "../../pi-session-memory/session-note.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  browseItemFromMeta,
  browseItemFromProject,
  displayTitle,
  formatDateShort,
  singleLine,
  splitFirstLines,
} from "../../pi-session-memory/session-browser.js";

test("extractProject decodes double-dash Pi session directory name", () => {
  assert.strictEqual(
    extractProject("/home/user/.pi/agent/sessions/--C--10x001--pi extensions--/session.jsonl"),
    "C:/10x001/pi extensions",
  );
});

test("extractProject best-effort decodes single-dash Pi encoding", () => {
  assert.strictEqual(
    extractProject("/home/user/.pi/agent/sessions/--C--10x001-pi extensions--/session.jsonl"),
    "C:/10x001-pi extensions",
  );
});

test("extractProject falls back to parent directory name", () => {
  assert.strictEqual(extractProject("/some/path/to/project/session.jsonl"), "project");
});

test("extractProjectFromSessionFile prefers session header cwd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-proj-"));
  // Path encoding would yield a mangled label; header cwd is authoritative.
  const sourcePath = path.join(dir, "--C--10x001-pi extensions--", "session.jsonl");
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(
    sourcePath,
    [
      JSON.stringify({ type: "session", id: "x", cwd: "C:\\10x001\\pi extensions" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ].join("\n") + "\n",
    "utf-8",
  );
  try {
    assert.strictEqual(extractProjectFromSessionFile(sourcePath), "C:/10x001/pi extensions");
    assert.strictEqual(normalizeProjectPath("C:\\foo\\bar\\"), "C:/foo/bar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeExportFileName is short readable date_time_project_topic_id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  // Mimic real session dir encoding + header cwd for project leaf.
  const sessDir = path.join(dir, "--C--projects-example--");
  mkdirSync(sessDir, { recursive: true });
  const sourcePath = path.join(sessDir, "2026-06-22T12-13-32-161Z_019fc680-8715-752d-b08e-e423e88d28b9.jsonl");
  writeFileSync(
    sourcePath,
    [
      JSON.stringify({ type: "session", id: "x", cwd: "C:\\projects\\example" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello world test" } }),
    ].join("\n") + "\n",
    "utf-8",
  );
  try {
    const name = makeExportFileName(sourcePath, "chat");
    // 2026-06-22_1213_example_hello-world-test_019fc680.chat.md
    assert.match(name, /^2026-06-22_1213_example_hello-world-test_019fc680\.chat\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeExportFileName strips Windows paths and keeps Cyrillic topic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sessDir = path.join(dir, "--C--projects-example--");
  mkdirSync(sessDir, { recursive: true });
  const sourcePath = path.join(sessDir, "2026-08-03T07-22-19-797Z_019fc680-8715-752d-b08e-e423e88d28b9.jsonl");
  writeFileSync(
    sourcePath,
    [
      JSON.stringify({ type: "session", id: "x", cwd: "C:\\projects\\example" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content:
            "C:\\Users\\user\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe и хз где настройки и другие его файлы",
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  try {
    const name = makeExportFileName(sourcePath, "outline-reasoning");
    // Must NOT be cusersuserappdata...
    assert.doesNotMatch(name, /cusers|appdata|roaming|desktop/i);
    assert.match(name, /^2026-08-03_0722_example_/);
    assert.match(name, /_019fc680\.outline-reasoning\.md$/);
    // Cyrillic topic kept (slugified), path crumbs gone
    assert.match(name, /настройки|хз|где|файлы/);
    assert.ok(name.length < 120, `filename too long: ${name.length} ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportSessionToMarkdown chat format includes only user/assistant text", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sourcePath = path.join(dir, "session.jsonl");
  const lines = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x" }] } },
  ];
  writeFileSync(sourcePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");

  try {
    const result = exportSessionToMarkdown(sourcePath, "chat", dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    const text = readFileSync(result.path, "utf-8");
    assert.match(text, /## User/);
    assert.match(text, /## Assistant/);
    assert.doesNotMatch(text, /## Tool result/);
    assert.strictEqual(result.entries, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportSessionToMarkdown full format includes tool results", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sourcePath = path.join(dir, "session.jsonl");
  const lines = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "run" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "file.txt" }] } },
  ];
  writeFileSync(sourcePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");

  try {
    const result = exportSessionToMarkdown(sourcePath, "full", dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    const text = readFileSync(result.path, "utf-8");
    assert.match(text, /## Tool result/);
    assert.match(text, /file\.txt/);
    assert.strictEqual(result.entries, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportSessionToMarkdown outline analytical: full args, status results, no custom/body", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sourcePath = path.join(dir, "session.jsonl");
  const lines = [
    { type: "session", id: "s1", cwd: "C:\\10x001\\pi extensions" },
    { type: "custom", customType: "tool-timestamp", data: { tool: "read", durMs: 5 } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "look" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I will read the file first." },
          { type: "text", text: "Reading now." },
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: 'ls -la "C:/tmp/demo"' },
          },
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "total 12\nfile-a\nfile-b" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "ENOENT: no such file or directory, open 'a.ts'" }],
      },
    },
    { type: "custom", customType: "tool-timestamp", data: { tool: "bash" } },
  ];
  writeFileSync(sourcePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");

  try {
    const outline = exportSessionToMarkdown(sourcePath, "outline", dir);
    assert.strictEqual(outline.ok, true);
    if (!outline.ok) return;
    const outlineText = readFileSync(outline.path, "utf-8");
    assert.match(outlineText, /\*\*Project:\*\* C:\/10x001\/pi extensions/);
    // Full args, not short "bash: ls …"
    assert.match(outlineText, /### Actions/);
    assert.match(outlineText, /- \[1\] bash/);
    assert.match(outlineText, /command: ls -la "C:\/tmp\/demo"/);
    assert.match(outlineText, /- \[2\] read/);
    assert.match(outlineText, /path: a\.ts/);
    // Status-only results paired on the same assistant turn
    assert.match(outlineText, /### Results/);
    assert.match(outlineText, /- \[1\] ✅ bash/);
    assert.match(outlineText, /- \[2\] ❌ read — ENOENT/);
    // No tool body, no custom noise, no reasoning in plain outline
    assert.doesNotMatch(outlineText, /file-a/);
    assert.doesNotMatch(outlineText, /export const/);
    assert.doesNotMatch(outlineText, /tool-timestamp/);
    assert.doesNotMatch(outlineText, /I will read the file first/);
    assert.doesNotMatch(outlineText, /### Reasoning/);

    const reasoned = exportSessionToMarkdown(sourcePath, "outline-reasoning", dir);
    assert.strictEqual(reasoned.ok, true);
    if (!reasoned.ok) return;
    const reasonText = readFileSync(reasoned.path, "utf-8");
    assert.match(reasoned.path, /\.outline-reasoning\.md$/);
    assert.match(reasonText, /### Reasoning/);
    assert.match(reasonText, /I will read the file first/);
    assert.match(reasonText, /### Reply/);
    assert.match(reasonText, /Reading now/);
    assert.match(reasonText, /- \[1\] bash/);
    assert.match(reasonText, /command: ls -la "C:\/tmp\/demo"/);
    assert.match(reasonText, /### Results/);
    assert.match(reasonText, /- \[2\] ❌ read/);
    assert.doesNotMatch(reasonText, /tool-timestamp/);
    assert.doesNotMatch(reasonText, /file-a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportSessionToMarkdown full omits reasoning; reasoning format separates it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sourcePath = path.join(dir, "session.jsonl");
  const lines = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "why?" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should explain carefully." },
          { type: "text", text: "Because it works." },
        ],
      },
    },
  ];
  writeFileSync(sourcePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");

  try {
    const full = exportSessionToMarkdown(sourcePath, "full", dir);
    assert.strictEqual(full.ok, true);
    if (!full.ok) return;
    const fullText = readFileSync(full.path, "utf-8");
    assert.doesNotMatch(fullText, /### Reasoning/);
    assert.doesNotMatch(fullText, /I should explain carefully/);
    assert.match(fullText, /Because it works/);

    const reasoned = exportSessionToMarkdown(sourcePath, "reasoning", dir);
    assert.strictEqual(reasoned.ok, true);
    if (!reasoned.ok) return;
    const reasonText = readFileSync(reasoned.path, "utf-8");
    assert.match(reasonText, /### Reasoning/);
    assert.match(reasonText, /I should explain carefully/);
    assert.match(reasonText, /### Final answer/);
    assert.match(reasonText, /Because it works/);
    assert.match(reasoned.path, /\.reasoning\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportSessionToMarkdown real-full keeps long tool results and meta entries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sourcePath = path.join(dir, "session.jsonl");
  const longResult = "x".repeat(3000);
  const lines = [
    { type: "session", id: "abc", version: 3, cwd: "/tmp/demo" },
    { type: "model_change", provider: "test", modelId: "m1" },
    { type: "custom", customType: "role-switcher", data: { role: "base" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "dump" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "full dump path" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call_1",
        content: [{ type: "text", text: longResult }],
      },
    },
  ];
  writeFileSync(sourcePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");

  try {
    const collapsed = exportSessionToMarkdown(sourcePath, "full", dir);
    assert.strictEqual(collapsed.ok, true);
    if (!collapsed.ok) return;
    const collapsedText = readFileSync(collapsed.path, "utf-8");
    assert.match(collapsedText, /<details>/);
    assert.doesNotMatch(collapsedText, /## Session header/);
    assert.doesNotMatch(collapsedText, /full dump path/);

    const real = exportSessionToMarkdown(sourcePath, "real-full", dir);
    assert.strictEqual(real.ok, true);
    if (!real.ok) return;
    const realText = readFileSync(real.path, "utf-8");
    assert.doesNotMatch(realText, /<details>/);
    assert.match(realText, new RegExp(longResult.slice(0, 40)));
    assert.match(realText, /### Reasoning/);
    assert.match(realText, /full dump path/);
    assert.match(realText, /## Session header/);
    assert.match(realText, /## Model change/);
    assert.match(realText, /## Custom — role-switcher/);
    assert.match(realText, /call_1/);
    assert.match(real.path, /\.real-full\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportSessionToMarkdown rejects missing file", () => {
  const result = exportSessionToMarkdown("/nonexistent/session.jsonl", "chat", "/tmp");
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Cannot stat session file/);
});

test("encodeSessionDirName matches Pi single-dash session folder encoding", () => {
  // Pi: `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  const name = encodeSessionDirName("C:\\10x001\\pi extensions");
  assert.strictEqual(name, "--C--10x001-pi extensions--");
});

test("sessionDirMatchesScope distinguishes project tree vs current vs all", () => {
  const cwd = "C:\\10x001\\pi extensions";
  const self = "--C--10x001-pi extensions--";
  const child = "--C--10x001-pi extensions-sub-agents--";
  const other = "--C--projects-example--";

  assert.strictEqual(sessionDirMatchesScope(self, cwd, "current"), true);
  assert.strictEqual(sessionDirMatchesScope(child, cwd, "current"), false);
  assert.strictEqual(sessionDirMatchesScope(self, cwd, "project"), true);
  assert.strictEqual(sessionDirMatchesScope(child, cwd, "project"), true);
  assert.strictEqual(sessionDirMatchesScope(other, cwd, "project"), false);
  assert.strictEqual(sessionDirMatchesScope(other, cwd, "all"), true);
  assert.strictEqual(nextSessionScope("project"), "current");
  assert.strictEqual(nextSessionScope("current"), "projects");
  assert.strictEqual(nextSessionScope("projects"), "all");
  assert.strictEqual(nextSessionScope("all"), "project");
  assert.strictEqual(nextSessionScope("project", { skipCurrent: true }), "projects");
  assert.strictEqual(nextSessionScope("projects", { skipCurrent: true }), "all");
});

test("listScopedSessions filters by scope and builds titles from head scan", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-scoped-"));
  const cwd = "C:\\10x001\\pi extensions";
  const selfDir = path.join(root, encodeSessionDirName(cwd));
  const childDir = path.join(root, "--C--10x001-pi extensions-sub-agents--");
  const otherDir = path.join(root, "--C--projects-example--");
  mkdirSync(selfDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });

  const selfPath = path.join(selfDir, "2026-06-22T12-13-32-161Z_aaaa.jsonl");
  const childPath = path.join(childDir, "2026-06-22T13-00-00-000Z_bbbb.jsonl");
  const otherPath = path.join(otherDir, "2026-06-22T14-00-00-000Z_cccc.jsonl");

  writeFileSync(
    selfPath,
    [
      JSON.stringify({ type: "session", id: "1", cwd: "C:\\10x001\\pi extensions", timestamp: "2026-06-22T12:13:32.161Z" }),
      JSON.stringify({ type: "session_info", name: "Browser refactor" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "implement local sessions browser" }] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", name: "read", arguments: { path: "x" } },
          ],
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    childPath,
    JSON.stringify({ type: "session", id: "2", cwd: "C:\\10x001\\pi extensions\\sub-agents" }) +
      "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: "child work" } }) +
      "\n",
    "utf-8",
  );
  writeFileSync(
    otherPath,
    JSON.stringify({ type: "session", id: "3", cwd: "C:\\projects\\example" }) +
      "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: "other project" } }) +
      "\n",
    "utf-8",
  );

  try {
    const project = listScopedSessions({ cwd, scope: "project", sessionsDir: root, limit: 50 });
    assert.strictEqual(project.length, 2);
    assert.ok(project.some((s) => s.source_path === selfPath));
    assert.ok(project.some((s) => s.source_path === childPath));
    assert.ok(!project.some((s) => s.source_path === otherPath));

    const current = listScopedSessions({ cwd, scope: "current", sessionsDir: root, limit: 50 });
    assert.strictEqual(current.length, 1);
    assert.strictEqual(current[0].source_path, selfPath);
    assert.strictEqual(current[0].name, "Browser refactor");
    assert.match(current[0].title, /Browser refactor|implement local/);
    assert.ok(current[0].tools.includes("read"));

    const all = listScopedSessions({ cwd, scope: "all", sessionsDir: root, limit: 50 });
    assert.strictEqual(all.length, 3);

    const byDir = listScopedSessions({
      cwd,
      scope: "current",
      sessionsDir: root,
      dirName: "--C--projects-example--",
      limit: 50,
    });
    assert.strictEqual(byDir.length, 1);
    assert.strictEqual(byDir[0].source_path, otherPath);

    assert.strictEqual(hasChildSessionDirs(cwd, root), true);
    assert.strictEqual(hasChildSessionDirs("C:\\projects\\example", root), false);

    const projects = listSessionProjects({ sessionsDir: root });
    assert.strictEqual(projects.length, 3);
    assert.ok(projects.every((p) => p.count === 1));
    assert.ok(projects.some((p) => p.dirName === encodeSessionDirName(cwd) && p.project.replace(/\\/g, "/").includes("pi extensions")));
    const projRow = browseItemFromProject(projects[0]);
    assert.strictEqual(projRow.kind, "project");
    assert.ok(projRow.dirName);
    assert.ok((projRow.sessionCount ?? 0) >= 1);

    const preview = buildChatPreview(selfPath);
    assert.strictEqual(preview.meta.title, "Browser refactor");
    assert.strictEqual(preview.messages[0]?.role, "user");
    assert.match(preview.messages[0]?.text || "", /implement local sessions browser/);
    assert.ok(preview.messages.some((m) => m.role === "assistant"));
    assert.ok(preview.meta.tools.includes("read"));

    const metaOnly = readSessionMeta(selfPath);
    assert.strictEqual(metaOnly.name, "Browser refactor");

    const row = browseItemFromMeta(current[0]);
    assert.strictEqual(row.title, "Browser refactor");
    assert.match(row.subtitle || row.mtimeLabel || "", /\d/);
    // List row must stay short — no full project path dump
    assert.ok(!row.title.includes("C:\\"));
    assert.ok((row.subtitle + (row.toolsLabel || "")).length < 80);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("displayTitle collapses bare filesystem paths", () => {
  assert.strictEqual(
    displayTitle("C:\\10x001\\pi extensions\\pi-session-memory\\index.ts", "fb"),
    "index.ts",
  );
  assert.match(displayTitle("agents docs -> runtime resume", "fb"), /agents docs/);
});

test("isDifferentProject compares session project to current cwd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-proj-diff-"));
  try {
    const same = path.join(dir, "--C--10x001-pi extensions--", "session.jsonl");
    mkdirSync(path.dirname(same), { recursive: true });
    writeFileSync(
      same,
      [
        JSON.stringify({ type: "session", id: "x", cwd: "C:\\10x001\\pi extensions" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      ].join("\n") + "\n",
      "utf-8",
    );

    // Same project (header cwd wins over encoded dir name) → no switch warning.
    assert.strictEqual(isDifferentProject(same, "C:/10x001/pi extensions"), false);
    assert.strictEqual(isDifferentProject(same, "C:\\10x001\\pi extensions\\"), false);
    // Different project → warn.
    assert.strictEqual(isDifferentProject(same, "C:/10x001/other-project"), true);

    // Unreadable/missing file: falls back to encoded dir name decoding.
    // Single-dash encoding is lossy: `--C--10x001-other-project--` decodes to
    // `C:/10x001-other-project`, NOT `C:/10x001/other-project`.
    const missing = path.join(dir, "--C--10x001-other-project--", "session.jsonl");
    assert.strictEqual(isDifferentProject(missing, "C:/10x001/pi extensions"), true);
    assert.strictEqual(isDifferentProject(missing, "C:/10x001-other-project"), false);
    const missingRoot = path.join(dir, "--C--10x001--", "session.jsonl");
    assert.strictEqual(isDifferentProject(missingRoot, "C:/10x001"), false);
    assert.strictEqual(isDifferentProject(missingRoot, "C:/10x001/sub"), true);

    // Empty inputs → never warn.
    assert.strictEqual(isDifferentProject("", "C:/10x001/pi extensions"), false);
    assert.strictEqual(isDifferentProject(same, ""), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitFirstLines word-wraps a long first message into two visible lines", () => {
  // Fits one line -> no second line.
  assert.deepStrictEqual(splitFirstLines("short message", 40), ["short message", ""]);
  assert.deepStrictEqual(splitFirstLines("", 10), ["", ""]);

  // Line 1 is a full wrap — no "..." (that made wrap look like a mid-sentence cut).
  const [w1, w2] = splitFirstLines("alpha beta gamma delta epsilon", 14);
  assert.strictEqual(w1, "alpha beta");
  assert.strictEqual(w2, "gamma delta...");
  assert.ok(!w1.endsWith("..."));
  assert.ok(visibleWidth(w1) <= 14 && visibleWidth(w2) <= 14);

  // Second line fits the rest: no trailing ellipsis on it.
  const [r1, r2] = splitFirstLines("alpha beta gamma", 14);
  assert.strictEqual(r1, "alpha beta");
  assert.strictEqual(r2, "gamma");

  // Long unbreakable: hard wrap, ellipsis only on line 2 when more remains.
  const long = "a".repeat(120);
  const [l1, l2] = splitFirstLines(long, 20);
  assert.strictEqual(l1, "a".repeat(20));
  assert.ok(l2.endsWith("..."));
  assert.ok(visibleWidth(l2) <= 20);
  assert.ok(!l1.endsWith("..."));
});

test("formatDateShort renders absolute date (same year) and year variant", () => {
  const sameYear = new Date();
  const iso = `${sameYear.getFullYear()}-08-13T12:24:16`;
  assert.strictEqual(formatDateShort(iso), "Aug 13 12:24");
  assert.strictEqual(formatDateShort(undefined), "");
  assert.strictEqual(formatDateShort(""), "");
  // Different year -> no time, year included.
  assert.match(formatDateShort("2025-08-13T12:24:16"), /^Aug 13 2025$/);
  // ms timestamp works too.
  assert.strictEqual(formatDateShort(new Date(2026, 7, 13, 20, 19).getTime()), "Aug 13 20:19");
});

test("parseAnnotationReply tolerates fences, bullets, russian labels and a missing title", () => {
  const plain = parseAnnotationReply("TITLE: Доработка pi-session-memory\nSUMMARY: Разбирали хранилище аннотаций.");
  assert.strictEqual(plain?.title, "Доработка pi-session-memory");
  assert.strictEqual(plain?.summary, "Разбирали хранилище аннотаций.");

  const fenced = parseAnnotationReply("```\n**TITLE:** Кэш и аннотации\n**SUMMARY:** Обсуждали стоимость хода.\n```");
  assert.strictEqual(fenced?.title, "Кэш и аннотации");
  assert.match(fenced?.summary || "", /стоимость/);

  const ru = parseAnnotationReply("- ЗАГОЛОВОК: Тест парсера\n- АННОТАЦИЯ: Проверка формата.");
  assert.strictEqual(ru?.title, "Тест парсера");
  assert.strictEqual(ru?.summary, "Проверка формата.");

  // A summary-only reply derives the title from it; prose with no fields is a failure.
  const derived = parseAnnotationReply("SUMMARY: Только аннотация без заголовка.");
  assert.strictEqual(derived?.title, "Только аннотация без заголовка.");
  assert.strictEqual(parseAnnotationReply("не понял задачу, уточните"), undefined);
  assert.strictEqual(parseAnnotationReply(""), undefined);
});

test("writeSessionNote inserts one line at the head and re-points the first entry", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-note-"));
  const file = path.join(dir, "s.jsonl");
  const header = { type: "session", version: 3, id: "abc", timestamp: "2026-10-14T10:00:00.000Z", cwd: "C:/10x001/x" };
  const first = { type: "model_change", id: "e1", parentId: null, timestamp: "2026-10-14T10:00:01.000Z", provider: "p", modelId: "m" };
  const second = {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-10-14T10:00:02.000Z",
    message: { role: "user", content: [{ type: "text", text: "привет" }] },
  };
  const body = (o: unknown) => JSON.stringify(o) + "\n";
  writeFileSync(file, body(header) + body(first) + body(second), "utf-8");

  try {
    const res = writeSessionNote(file, {
      title: "Заголовок",
      summary: "Аннотация сессии.",
      at: "2026-10-14T11:00:00.000Z",
      model: "p/m",
    });
    assert.strictEqual(res.ok, true, res.error);

    const raw = readFileSync(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 4);
    assert.deepStrictEqual(lines[0], header); // header untouched
    assert.strictEqual(lines[1].type, "custom");
    assert.strictEqual(lines[1].customType, "session-memory-note");
    assert.strictEqual(lines[1].parentId, null);
    assert.strictEqual(lines[1].data.title, "Заголовок");
    assert.strictEqual(lines[1].data.summary, "Аннотация сессии.");
    assert.strictEqual(lines[2].id, "e1");
    assert.strictEqual(lines[2].parentId, lines[1].id); // single root preserved
    assert.deepStrictEqual(lines[3], second); // tail copied verbatim
    assert.ok(raw.startsWith(body(header)));
    assert.ok(raw.endsWith(body(second)));

    const note = readSessionNote(file);
    assert.strictEqual(note?.note.title, "Заголовок");
    assert.strictEqual(note?.note.model, "p/m");

    // Re-annotation rewrites the same line: same id, no growth, first entry untouched.
    const again = writeSessionNote(file, { title: "Второй заход", summary: "Обновлено.", at: "2026-10-14T12:00:00.000Z" });
    assert.strictEqual(again.ok, true, again.error);
    assert.strictEqual(again.id, res.id);
    const raw2 = readFileSync(file, "utf-8");
    const lines2 = raw2.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(lines2.length, 4);
    assert.strictEqual(lines2[1].data.title, "Второй заход");
    assert.deepStrictEqual(lines2[2], lines[2]);
    assert.ok(!raw2.includes("Заголовок"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSessionMeta surfaces the annotation head-first and lets a newer rename win", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-note-meta-"));
  const file = path.join(dir, "s.jsonl");
  const header = { type: "session", version: 3, id: "abc", timestamp: "2026-10-14T10:00:00.000Z", cwd: "C:/10x001/pi extensions" };
  const first = { type: "model_change", id: "e1", parentId: null, timestamp: "2026-10-14T10:00:01.000Z", provider: "p", modelId: "m" };
  const filler: string[] = [];
  for (let i = 0; i < 120; i++) {
    filler.push(
      JSON.stringify({
        type: "message",
        id: `f${i}`,
        parentId: "e1",
        timestamp: "2026-10-14T10:01:00.000Z",
        message: { role: "user", content: "x".repeat(1000) },
      }) + "\n",
    );
  }
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(first) + "\n" + filler.join(""), "utf-8");

  try {
    const res = writeSessionNote(file, {
      title: "Сгенерированный заголовок",
      summary: "Сводка по сессии.",
      at: "2026-10-14T11:00:00.000Z",
    });
    assert.strictEqual(res.ok, true, res.error);

    let meta = readSessionMeta(file);
    assert.strictEqual(meta.title, "Сгенерированный заголовок");
    assert.strictEqual(meta.annotation?.summary, "Сводка по сессии.");
    assert.strictEqual(meta.project.replace(/\\/g, "/"), "C:/10x001/pi extensions");

    const row = browseItemFromMeta(meta);
    assert.strictEqual(row.annotation?.summary, "Сводка по сессии.");

    // A manual rename lands at the leaf — past the head window. The tail is a secondary
    // source: the newer name wins, the summary lives on.
    appendFileSync(
      file,
      JSON.stringify({
        type: "session_info",
        id: "e9",
        parentId: "e1",
        timestamp: "2026-10-14T12:00:00.000Z",
        name: "Ручное имя",
      }) + "\n",
      "utf-8",
    );
    meta = readSessionMeta(file);
    assert.strictEqual(meta.title, "Ручное имя");
    assert.strictEqual(meta.annotation?.title, "Ручное имя");
    assert.strictEqual(meta.annotation?.summary, "Сводка по сессии.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("singleLine clips an annotated row to one visible line", () => {
  assert.strictEqual(singleLine("короткая строка", 40), "короткая строка");
  assert.strictEqual(singleLine("", 40), "");
  assert.strictEqual(singleLine("   сжатые    пробелы  ", 40), "сжатые пробелы");
  const long = singleLine("first sentence here and then a lot more text that will not fit", 20);
  assert.ok(long.endsWith("..."));
  assert.ok(visibleWidth(long) <= 20);
});

test("parseAnnotationReply stores a slightly over-limit title verbatim", () => {
  // A 66-char title used to be cut at 60 with an ellipsis, losing the distinguishing tail word.
  const title = "OpenCode Go vs Zen: модели, эндпоинты, доки и правки agent-browser";
  const parsed = parseAnnotationReply(`TITLE: ${title}\nSUMMARY: ${"слово ".repeat(140)}`);
  assert.strictEqual(parsed?.title, title);
  assert.ok(!title.includes("…"));
  const summary = parsed?.summary || "";
  assert.ok(summary.length <= 600, `summary is ${summary.length}`);
  assert.ok(summary.endsWith("…"));
});
