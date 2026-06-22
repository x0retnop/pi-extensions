import { test } from "node:test";
import assert from "node:assert";
import { classifyPathAccess, normalizePath, looksLikePath, cwdIsTooBroad } from "../../simple-gate/path-guard.js";

const cwd = "C:/10x001/project";

test("normalizePath converts Git Bash /c/... to Windows drive", () => {
  const normalizedWindows = normalizePath("/c/Windows", cwd).toLowerCase().replace(/\\/g, "/");
  assert.ok(normalizedWindows.endsWith("c:/windows"), `expected c:/windows, got ${normalizedWindows}`);
});

test("normalizePath expands ~ to home", () => {
  const expanded = normalizePath("~/.ssh/id_rsa", cwd);
  assert.ok(expanded.toLowerCase().includes(".ssh"));
  assert.ok(expanded.endsWith("id_rsa"));
});

test("looksLikePath rejects flags and URLs, accepts file paths", () => {
  assert.strictEqual(looksLikePath("C:/foo/bar.txt"), true);
  assert.strictEqual(looksLikePath("./src/index.ts"), true);
  assert.strictEqual(looksLikePath("-flag"), false);
  assert.strictEqual(looksLikePath("--help"), false);
  assert.strictEqual(looksLikePath("https://example.com"), false);
  assert.strictEqual(looksLikePath("\\\\"), false);
});

test("classifyPathAccess scopes paths correctly", () => {
  assert.strictEqual(classifyPathAccess(`${cwd}/src/main.ts`, cwd, [], []).scope, "inside_project");
  assert.strictEqual(classifyPathAccess("C:/other/file.txt", cwd, [], []).scope, "outside_project");
  assert.strictEqual(classifyPathAccess("C:/Windows/system.ini", cwd, [], []).scope, "protected");
  assert.strictEqual(classifyPathAccess("~/.ssh/config", cwd, [], []).scope, "protected");
});

test("workspace roots expand the inside_project scope", () => {
  const workspaceRoots = ["C:/10x001"].map((r) => normalizePath(r, cwd).toLowerCase());
  assert.strictEqual(classifyPathAccess("C:/10x001/other/file.txt", cwd, workspaceRoots, []).scope, "inside_project");
});

test("cwdIsTooBroad flags home, Desktop, Documents, Downloads, and drive root", () => {
  assert.strictEqual(cwdIsTooBroad("C:/"), true);
  assert.strictEqual(cwdIsTooBroad(cwd), false);
});
