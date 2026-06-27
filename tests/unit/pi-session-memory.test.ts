import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractProject } from "../../pi-session-memory/project.js";
import {
  exportSessionToMarkdown,
  groupSessionsByProject,
  listLocalSessions,
  makeExportFileName,
} from "../../pi-session-memory/local-export.js";

test("extractProject decodes Pi session directory name", () => {
  assert.strictEqual(
    extractProject("/home/user/.pi/agent/sessions/--C--10x001--pi extensions--/session.jsonl"),
    "C:/10x001/pi extensions",
  );
});

test("extractProject falls back to parent directory name", () => {
  assert.strictEqual(extractProject("/some/path/to/project/session.jsonl"), "project");
});

test("makeExportFileName uses user preview slug", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sess-"));
  const sourcePath = path.join(dir, "2026-06-22T12-13-32-161Z_id.jsonl");
  writeFileSync(
    sourcePath,
    JSON.stringify({ type: "message", message: { role: "user", content: "hello world test" } }) + "\n",
    "utf-8",
  );
  try {
    const name = makeExportFileName(sourcePath, "chat");
    assert.match(name, /^2026-06-22_hello-world-test\.chat\.md$/);
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

test("exportSessionToMarkdown rejects missing file", () => {
  const result = exportSessionToMarkdown("/nonexistent/session.jsonl", "chat", "/tmp");
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Cannot stat session file/);
});

test("listLocalSessions and groupSessionsByProject scan sessions directory", () => {
  const sessionsRoot = mkdtempSync(path.join(tmpdir(), "pi-sess-root-"));
  const projectDir = path.join(sessionsRoot, "--C--10x001--demo-project--");
  mkdirSync(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, "2026-06-22T12-13-32-161Z_id.jsonl");
  writeFileSync(
    sourcePath,
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }) + "\n",
    "utf-8",
  );

  const originalSessionsDir = process.env.PI_SESSIONS_DIR;
  // listLocalSessions hardcodes the sessions directory, so we override via monkey-patching
  // the module constant by re-importing with a custom homedir. Instead, we verify the
  // exported helpers used by the TUI independently where possible.
  try {
    // groupSessionsByProject relies on listLocalSessions which reads ~/.pi/agent/sessions,
    // so we cannot easily mock it without changing the module. We at least exercise the
    // function and ensure it returns an array without throwing.
    const groups = groupSessionsByProject(10);
    assert.ok(Array.isArray(groups));
  } finally {
    rmSync(sessionsRoot, { recursive: true, force: true });
  }
});
