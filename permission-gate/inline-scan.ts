import type { Risk, Category } from "./types.js";

interface ScanResult {
  risk: Risk;
  categories: Category[];
  reasons: string[];
}

// ─── Python ───

const PYTHON_RISKY_PATTERNS: Array<{ regex: RegExp; risk: Risk; category: Category; name: string }> = [
  // Write
  { regex: /\bopen\s*\([^)]*[,\s]["'][^"']*[wax+]/i, risk: "write", category: "write", name: "open with write/append mode" },
  { regex: /\.write\s*\(/i, risk: "write", category: "write", name: ".write()" },
  { regex: /\.write_text\s*\(/i, risk: "write", category: "write", name: ".write_text()" },
  { regex: /\.write_bytes\s*\(/i, risk: "write", category: "write", name: ".write_bytes()" },
  { regex: /\.touch\s*\(/i, risk: "write", category: "write", name: ".touch()" },
  { regex: /\.mkdir\s*\(/i, risk: "write", category: "write", name: ".mkdir()" },
  // Delete
  { regex: /\bos\.remove\s*\(/i, risk: "delete", category: "delete", name: "os.remove()" },
  { regex: /\bos\.unlink\s*\(/i, risk: "delete", category: "delete", name: "os.unlink()" },
  { regex: /\bos\.rmdir\s*\(/i, risk: "delete", category: "delete", name: "os.rmdir()" },
  { regex: /\bos\.removedirs\s*\(/i, risk: "delete", category: "delete", name: "os.removedirs()" },
  { regex: /\bshutil\.rmtree\b/i, risk: "delete", category: "delete", name: "shutil.rmtree" },
  { regex: /\bshutil\.move\b/i, risk: "write", category: "write", name: "shutil.move" },
  { regex: /\bshutil\.copy\b/i, risk: "write", category: "write", name: "shutil.copy" },
  // Execute
  { regex: /\bsubprocess\b/i, risk: "execute", category: "execute", name: "subprocess" },
  { regex: /\bos\.system\s*\(/i, risk: "execute", category: "execute", name: "os.system()" },
  { regex: /\bos\.popen\s*\(/i, risk: "execute", category: "execute", name: "os.popen()" },
  // Network
  { regex: /\burllib\.request\b/i, risk: "network", category: "network", name: "urllib.request" },
  { regex: /\brequests\./i, risk: "network", category: "network", name: "requests" },
  { regex: /\bhttpx\./i, risk: "network", category: "network", name: "httpx" },
  { regex: /\bsocket\./i, risk: "network", category: "network", name: "socket" },
  // Install
  { regex: /\bpip\s+install\b/i, risk: "install", category: "install", name: "pip install" },
];

// ─── Node.js ───

const NODE_RISKY_PATTERNS: Array<{ regex: RegExp; risk: Risk; category: Category; name: string }> = [
  // Write
  { regex: /\bfs\.write/i, risk: "write", category: "write", name: "fs.write*" },
  { regex: /\bwriteFileSync\b/i, risk: "write", category: "write", name: "fs.writeFileSync()" },
  { regex: /\bwriteFile\b/i, risk: "write", category: "write", name: "fs.writeFile()" },
  { regex: /\bappendFileSync\b/i, risk: "write", category: "write", name: "fs.appendFileSync()" },
  { regex: /\bappendFile\b/i, risk: "write", category: "write", name: "fs.appendFile()" },
  { regex: /\bfs\.copyFile/i, risk: "write", category: "write", name: "fs.copyFile*" },
  { regex: /\bfs\.rename/i, risk: "write", category: "write", name: "fs.rename*" },
  { regex: /\bcreateWriteStream\b/i, risk: "write", category: "write", name: "createWriteStream()" },
  // Delete
  { regex: /\bfs\.unlink/i, risk: "delete", category: "delete", name: "fs.unlink*" },
  { regex: /\bfs\.rmdir/i, risk: "delete", category: "delete", name: "fs.rmdir*" },
  { regex: /\bfs\.rm\b/i, risk: "delete", category: "delete", name: "fs.rm*" },
  { regex: /\bunlinkSync\b/i, risk: "delete", category: "delete", name: "fs.unlinkSync()" },
  // Execute
  { regex: /\bchild_process\b/i, risk: "execute", category: "execute", name: "child_process" },
  { regex: /\bspawn\s*\(/i, risk: "execute", category: "execute", name: "spawn()" },
  { regex: /\bexec\s*\(/i, risk: "execute", category: "execute", name: "exec()" },
  { regex: /\bexecSync\s*\(/i, risk: "execute", category: "execute", name: "execSync()" },
  { regex: /\beval\s*\(/i, risk: "execute", category: "execute", name: "eval()" },
  { regex: /\bnew\s+Function\b/i, risk: "execute", category: "execute", name: "new Function()" },
  // Network
  { regex: /\brequire\s*\(\s*["']http["']\s*\)/i, risk: "network", category: "network", name: "require('http')" },
  { regex: /\brequire\s*\(\s*["']https["']\s*\)/i, risk: "network", category: "network", name: "require('https')" },
  { regex: /\brequire\s*\(\s*["']net["']\s*\)/i, risk: "network", category: "network", name: "require('net')" },
  { regex: /\bfetch\s*\(/i, risk: "network", category: "network", name: "fetch()" },
  { regex: /\bcreateWriteStream\b/i, risk: "write", category: "write", name: "createWriteStream()" },
];

const RISK_ORDER: Risk[] = ["read", "write", "delete", "execute", "network", "install", "destructive"];

function maxRisk(a: Risk, b: Risk): Risk {
  const ia = RISK_ORDER.indexOf(a);
  const ib = RISK_ORDER.indexOf(b);
  return RISK_ORDER[Math.max(ia, ib)];
}

function unescapeQuoted(code: string): string {
  // Node/python inline args often have \" instead of " due to shell quoting
  return code.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function extractPythonCode(command: string): string | null {
  // python -c "..."
  const cMatch = command.match(/^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-c\s+(.+)$/is);
  if (cMatch) {
    let code = cMatch[1].trim();
    if ((code.startsWith('"') && code.endsWith('"')) || (code.startsWith("'") && code.endsWith("'"))) {
      code = code.slice(1, -1);
    }
    return unescapeQuoted(code);
  }

  // python - <<EOF
  const heredocMatch = command.match(/^\s*(?:python|py)(?:\s+-3(?:\.\d+)?)?\s+-\s*<<['"]?([A-Z_][A-Z0-9_]*)['"]?[\r\n]+([\s\S]*?)[\r\n]+\1\s*$/is);
  if (heredocMatch) {
    return heredocMatch[2];
  }

  return null;
}

function extractNodeCode(command: string): string | null {
  const match = command.match(/^\s*node(?:js)?(?:\s+--experimental-strip-types)?\s+-e\s+(.+)$/is);
  if (!match) return null;
  let code = match[1].trim();
  if ((code.startsWith('"') && code.endsWith('"')) || (code.startsWith("'") && code.endsWith("'"))) {
    code = code.slice(1, -1);
  }
  return unescapeQuoted(code);
}

export function scanInline(command: string): ScanResult | null {
  const pyCode = extractPythonCode(command);
  if (pyCode) {
    return scanCode(pyCode, PYTHON_RISKY_PATTERNS, "python");
  }

  const nodeCode = extractNodeCode(command);
  if (nodeCode) {
    return scanCode(nodeCode, NODE_RISKY_PATTERNS, "node");
  }

  return null;
}

function scanCode(code: string, patterns: typeof PYTHON_RISKY_PATTERNS, lang: string): ScanResult {
  let risk: Risk = "read";
  const categories: Category[] = [];
  const reasons: string[] = [];

  for (const p of patterns) {
    if (p.regex.test(code)) {
      risk = maxRisk(risk, p.risk);
      if (!categories.includes(p.category)) {
        categories.push(p.category);
      }
      reasons.push(`${lang}: ${p.name}`);
    }
  }

  return { risk, categories, reasons };
}
