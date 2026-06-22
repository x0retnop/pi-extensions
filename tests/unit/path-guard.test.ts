import { classifyPathAccess, normalizePath, looksLikePath } from "../../simple-gate/path-guard.js";
import assert from "node:assert";

const cwd = "C:/10x001/project";

console.log("test normalize");
const normalizedWindows = normalizePath("/c/Windows", cwd).toLowerCase().replace(/\\/g, "/");
assert.ok(normalizedWindows.endsWith("c:/windows"), `expected c:/windows, got ${normalizedWindows}`);

console.log("test looksLikePath");
assert.strictEqual(looksLikePath("C:/foo/bar.txt"), true);
assert.strictEqual(looksLikePath("-flag"), false);
assert.strictEqual(looksLikePath("https://example.com"), false);

console.log("test classify");
const access = classifyPathAccess("C:/10x001/project/src/main.ts", cwd, [], []);
assert.strictEqual(access.scope, "inside_project");

const outside = classifyPathAccess("C:/other/file.txt", cwd, [], []);
assert.strictEqual(outside.scope, "outside_project");

const prot = classifyPathAccess("C:/Windows/system.ini", cwd, [], []);
assert.strictEqual(prot.scope, "protected");

console.log("all path-guard tests passed");
