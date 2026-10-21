/**
 * Read-only timing of Pi's real extension loader.
 * Does not start Pi, bind a session, or write ~/.pi/agent/.
 */
process.env.PI_TIMING = "1";
process.env.PI_OFFLINE = "1";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi/agent");
const extDir = path.join(agentDir, "extensions");
const cwd = process.cwd();

const pkgRoot = path.join(
  process.env.APPDATA || "",
  "npm/node_modules/@earendil-works/pi-coding-agent/dist",
);
if (!fs.existsSync(pkgRoot)) {
  console.error(`Pi package not found: ${pkgRoot}`);
  process.exit(1);
}

const { loadExtensions } = await import(
  pathToFileURL(path.join(pkgRoot, "core/extensions/loader.js")).href
);

function countTs(dir) {
  let files = 0;
  let lines = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(p);
      } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js"))) {
        files += 1;
        try {
          lines += fs.readFileSync(p, "utf8").split(/\r?\n/).length;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return { files, lines };
}

function discoverIndexPaths(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const ts = path.join(dir, e.name, "index.ts");
    const js = path.join(dir, e.name, "index.js");
    if (fs.existsSync(ts)) out.push(ts);
    else if (fs.existsSync(js)) out.push(js);
  }
  return out;
}

const paths = discoverIndexPaths(extDir);
const rows = [];
const tAll = Date.now();

for (const extPath of paths) {
  const name = path.basename(path.dirname(extPath));
  const stats = countTs(path.dirname(extPath));
  const t0 = Date.now();
  const result = await loadExtensions([extPath], cwd);
  const ms = Date.now() - t0;
  const ext = result.extensions[0];
  const err = result.errors[0]?.error ?? null;
  rows.push({
    name,
    ms,
    files: stats.files,
    lines: stats.lines,
    tools: ext ? [...ext.tools.keys()] : [],
    events: ext ? [...ext.handlers.keys()] : [],
    cmds: ext ? [...ext.commands.keys()] : [],
    error: err,
  });
}

const wall = Date.now() - tAll;

const report = {
  v: 1,
  at: new Date().toISOString(),
  agentDir,
  extDir,
  cwd,
  count: rows.length,
  errors: rows.filter((r) => r.error).length,
  wallMs: wall,
  rows,
};

console.log(JSON.stringify(report));
