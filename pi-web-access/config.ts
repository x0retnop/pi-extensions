import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SearchProvider = "auto" | "exa-mcp" | "exa-api" | "ollama";

export interface PiWebAccessSettings {
	searchProvider?: SearchProvider;
	githubClone?: {
		enabled?: boolean;
		maxRepoSizeMB?: number;
		cloneTimeoutSeconds?: number;
		clonePath?: string;
	};
}

export interface AuthEntry {
	type?: string;
	key?: string;
}

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

let cachedSettings: PiWebAccessSettings | null = null;
let cachedAuth: Record<string, AuthEntry> | null = null;

function readJsonSafe<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJsonSafe(path: string, data: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function normalizeProvider(value: unknown): SearchProvider {
	const s = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (s === "exa-mcp" || s === "exa-api" || s === "ollama") return s;
	return "auto";
}

function getAuthEntry(provider: string): AuthEntry | null {
	if (!cachedAuth) {
		cachedAuth = readJsonSafe<Record<string, AuthEntry>>(AUTH_PATH) ?? {};
	}
	return cachedAuth[provider] ?? null;
}

export function getApiKey(provider: "exa" | "ollama"): string | null {
	const env = provider === "exa" ? process.env.EXA_API_KEY : process.env.OLLAMA_API_KEY;
	if (typeof env === "string" && env.trim().length > 0) return env.trim();
	const entry = getAuthEntry(provider);
	return entry?.key?.trim() || null;
}

export function setApiKey(provider: "exa" | "ollama", key: string): void {
	const auth = readJsonSafe<Record<string, AuthEntry>>(AUTH_PATH) ?? {};
	auth[provider] = { type: "api_key", key: key.trim() };
	cachedAuth = auth;
	writeJsonSafe(AUTH_PATH, auth);
}

function readSettingsRoot(): Record<string, unknown> {
	return readJsonSafe<Record<string, unknown>>(SETTINGS_PATH) ?? {};
}

export function loadSettings(): PiWebAccessSettings {
	if (cachedSettings) return cachedSettings;
	const root = readSettingsRoot();
	const raw = root.piWebAccess ?? {};
	cachedSettings = {
		searchProvider: normalizeProvider((raw as Record<string, unknown>).searchProvider),
		githubClone:
			typeof (raw as Record<string, unknown>).githubClone === "object" &&
			(raw as Record<string, unknown>).githubClone !== null
				? ((raw as Record<string, unknown>).githubClone as PiWebAccessSettings["githubClone"])
				: undefined,
	};
	return cachedSettings;
}

export function saveSettings(updates: PiWebAccessSettings): void {
	const root = readSettingsRoot();
	const current = (root.piWebAccess ?? {}) as PiWebAccessSettings;
	const next: PiWebAccessSettings = { ...current, ...updates };
	cachedSettings = next;
	root.piWebAccess = next;
	writeJsonSafe(SETTINGS_PATH, root);
}

export function maskKey(key: string | null): string {
	if (!key) return "(not set)";
	if (key.length <= 8) return "***";
	return key.slice(0, 4) + "..." + key.slice(-4);
}

export function clearConfigCache(): void {
	cachedSettings = null;
	cachedAuth = null;
}
