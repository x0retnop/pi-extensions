import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEBUG = process.env.PI_SUB_AGENTS_DEBUG === "1" || process.env.PI_SUB_AGENTS_DEBUG === "true";
const LOG_FILE_NAME = "pi-sub-agents.log";

function logPath(cwd: string): string {
  const dir = process.env.PI_SUB_AGENTS_LOG_DIR?.trim();
  if (dir) return join(dir, LOG_FILE_NAME);
  return join(cwd, LOG_FILE_NAME);
}

async function ensureDir(filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {
    // ignore
  }
}

function formatLine(level: string, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  let line = `${ts} [${level}] ${message}`;
  if (data !== undefined) {
    line += "\n  " + JSON.stringify(data, null, 2).split("\n").join("\n  ");
  }
  return line + "\n";
}

async function writeLog(filePath: string, level: string, message: string, data?: unknown): Promise<void> {
  await ensureDir(filePath);
  await appendFile(filePath, formatLine(level, message, data), "utf-8");
}

async function safeWriteLog(filePath: string, level: string, message: string, data?: unknown): Promise<void> {
  try {
    await writeLog(filePath, level, message, data);
  } catch {
    // Logging must never crash the extension.
  }
}

export function isDebugEnabled(): boolean {
  return DEBUG;
}

export async function debug(message: string, data?: unknown, cwd?: string): Promise<void> {
  if (!DEBUG || !cwd) return;
  await safeWriteLog(logPath(cwd), "DEBUG", message, data);
}

export async function info(message: string, data?: unknown, cwd?: string): Promise<void> {
  if (!cwd) return;
  await safeWriteLog(logPath(cwd), "INFO", message, data);
}

export async function error(message: string, data?: unknown, cwd?: string): Promise<void> {
  if (!cwd) return;
  await safeWriteLog(logPath(cwd), "ERROR", message, data);
}

export async function marker(message: string, cwd?: string): Promise<void> {
  if (!cwd) return;
  await info(`=== ${message} ===`, undefined, cwd);
}

export async function warn(message: string, data?: unknown, cwd?: string): Promise<void> {
  if (!cwd) return;
  await safeWriteLog(logPath(cwd), "WARN", message, data);
}
