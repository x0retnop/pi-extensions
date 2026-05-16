import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KIMI_CLI_VERSION, USER_AGENT } from "./constants.ts"

const DEVICE_ID_DIR = path.join(os.homedir(), ".kimi")
const DEVICE_ID_PATH = path.join(DEVICE_ID_DIR, "device_id")

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function getDeviceId(): string {
  ensureDir(DEVICE_ID_DIR)
  if (fs.existsSync(DEVICE_ID_PATH)) {
    const existing = fs.readFileSync(DEVICE_ID_PATH, "utf8").trim()
    if (existing) return existing
  }

  const id = crypto.randomUUID().replace(/-/g, "")
  fs.writeFileSync(DEVICE_ID_PATH, id, { mode: 0o600 })
  return id
}

export function asciiHeaderValue(value: string, fallback = "unknown") {
  const sanitized = value.replace(/[^\x20-\x7e]/g, "").trim()
  return sanitized || fallback
}

let cachedMacVersion: string | undefined

function macProductVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined
  if (cachedMacVersion !== undefined) return cachedMacVersion || undefined

  try {
    cachedMacVersion = childProcess.execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    cachedMacVersion = ""
  }

  return cachedMacVersion || undefined
}

export function kimiDeviceModel(input?: {
  system?: string
  release?: string
  machine?: string
  macVersion?: string
}) {
  const system = input?.system ?? os.type()
  const release = input?.release ?? os.release()
  const machine = input?.machine ?? os.machine?.() ?? os.arch()

  if (system === "Darwin") {
    const version = input?.macVersion ?? macProductVersion() ?? release
    if (version && machine) return `macOS ${version} ${machine}`
    if (version) return `macOS ${version}`
    return `macOS ${machine}`.trim()
  }

  if (system === "Windows_NT") {
    const parts = release.split(".")
    const build = Number(parts[2] ?? "")
    const label = parts[0] === "10" ? (Number.isFinite(build) && build >= 22_000 ? "11" : "10") : release
    if (label && machine) return `Windows ${label} ${machine}`
    if (label) return `Windows ${label}`
    return `Windows ${machine}`.trim()
  }

  if (release && machine) return `${system} ${release} ${machine}`
  if (release) return `${system} ${release}`
  return `${system} ${machine}`.trim()
}

export function kimiHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": asciiHeaderValue(os.hostname() || "unknown"),
    "X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
    "X-Msh-Device-Id": getDeviceId(),
    "X-Msh-Os-Version": asciiHeaderValue(os.version?.() || `${os.type()} ${os.release()}`),
  }
}
