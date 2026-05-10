import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandDB, CommandMeta, Risk, Category, GateMode, FlagMeta } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, "commanddb.json");

let cachedDB: CommandDB | null = null;
let cachedAliasMap: Map<string, string> | null = null;

export function loadCommandDB(): CommandDB {
  if (cachedDB) return cachedDB;
  if (!existsSync(DB_PATH)) {
    cachedDB = {};
    return cachedDB;
  }
  try {
    const raw = readFileSync(DB_PATH, "utf-8");
    cachedDB = JSON.parse(raw) as CommandDB;
  } catch {
    cachedDB = {};
  }
  return cachedDB;
}

export function buildAliasMap(db: CommandDB): Map<string, string> {
  if (cachedAliasMap) return cachedAliasMap;
  const map = new Map<string, string>();
  for (const [canonical, meta] of Object.entries(db)) {
    const key = canonical.toLowerCase();
    map.set(key, canonical);
    for (const alias of meta.aliases || []) {
      map.set(alias.toLowerCase(), canonical);
    }
  }
  cachedAliasMap = map;
  return map;
}

export function resolveCommand(name: string, db: CommandDB): string | undefined {
  const key = name.toLowerCase().trim();
  if (db[key]) return key;
  const map = buildAliasMap(db);
  return map.get(key);
}

export function getMeta(db: CommandDB, canonical: string): CommandMeta | undefined {
  return db[canonical];
}

export function resolveFlagEffect(
  flag: string,
  meta: CommandMeta,
  sub: string | undefined
): FlagMeta | undefined {
  const subMeta = sub ? meta.subcommands?.[sub] : undefined;
  const subFlags = subMeta?.flags;
  if (subFlags) {
    // Exact match
    if (subFlags[flag]) return subFlags[flag];
    // Partial match for combined short flags: -abc could be -a -b -c
    if (flag.startsWith("-") && !flag.startsWith("--") && flag.length > 2) {
      for (const f of Object.keys(subFlags)) {
        if (f.startsWith("-") && !f.startsWith("--") && flag.includes(f[1])) {
          return subFlags[f];
        }
      }
    }
  }
  const common = meta.commonFlags;
  if (common) {
    if (common[flag]) return common[flag];
    if (flag.startsWith("-") && !flag.startsWith("--") && flag.length > 2) {
      for (const f of Object.keys(common)) {
        if (f.startsWith("-") && !f.startsWith("--") && flag.includes(f[1])) {
          return common[f];
        }
      }
    }
  }
  return undefined;
}

const RISK_ORDER: Risk[] = ["read", "write", "delete", "execute", "network", "install", "destructive"];

export function maxRisk(a: Risk | "unknown", b: Risk | "unknown"): Risk | "unknown" {
  if (a === "unknown" || b === "unknown") return "unknown";
  const ia = RISK_ORDER.indexOf(a);
  const ib = RISK_ORDER.indexOf(b);
  return RISK_ORDER[Math.max(ia, ib)];
}

export function mergeCategories(a: Category[], b: Category[]): Category[] {
  return [...new Set([...a, ...b])];
}

export function isAutoAllowed(meta: { autoAllowModes?: GateMode[] }, mode: GateMode): boolean {
  return !!meta.autoAllowModes?.includes(mode);
}
