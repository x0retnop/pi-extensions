import { test } from "node:test";
import assert from "node:assert";
import {
  classifyPathAccess,
  normalizePath,
  looksLikePath,
  cwdIsTooBroad,
} from "../../simple-gate/path-guard.js";
import { decideBash } from "../../simple-gate/index.js";

const cwd = "C:/10x001/project";

function n(p: string): string {
  return normalizePath(p, cwd).toLowerCase().replace(/\\/g, "/");
}

test("normalizePath converts Git Bash /c/... to Windows drive", () => {
  assert.ok(n("/c/Windows").endsWith("c:/windows"));
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

const relaxedConfig = { mode: "relaxed" as const, protectedRoots: [], workspaceRoots: [] };
const strictConfig = { mode: "strict" as const, protectedRoots: [], workspaceRoots: [] };

test("decideBash allows safe commands inside the project", () => {
  const decision = decideBash("ls -la", cwd, relaxedConfig);
  assert.strictEqual(decision.action, "allow");
});

test("decideBash blocks destructive patterns", () => {
  const decision = decideBash("rm -rf /", cwd, relaxedConfig);
  assert.strictEqual(decision.action, "block");
  assert.ok(decision.reason?.includes("destructive"));
});

test("decideBash blocks protected paths outside the project", () => {
  const decision = decideBash("cat C:/Windows/system.ini", cwd, relaxedConfig);
  assert.strictEqual(decision.action, "block");
  assert.ok(decision.reason?.includes("protected"));
});

test("decideBash asks before writing outside the project in relaxed mode", () => {
  const decision = decideBash("cp file.txt C:/tmp/", cwd, relaxedConfig);
  assert.strictEqual(decision.action, "ask");
  assert.ok(decision.reason?.includes("outside"));
});

test("decideBash blocks writes outside project in strict mode", () => {
  const decision = decideBash("cp file.txt C:/tmp/", cwd, strictConfig);
  assert.strictEqual(decision.action, "block");
});
