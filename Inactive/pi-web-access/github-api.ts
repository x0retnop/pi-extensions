import { execFile } from "node:child_process";
import type { ExtractedContent } from "./extract.js";
import type { GitHubUrlInfo } from "./github-extract.js";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";

let ghAvailable: boolean | null = null;
let ghHintShown = false;

export async function checkGhAvailable(): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;

	return new Promise((resolve) => {
		execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
			ghAvailable = !err;
			resolve(ghAvailable);
		});
	});
}

export function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		console.error("[pi-web-access] Install `gh` CLI for better GitHub repo access including private repos.");
	}
}

interface RepoInfo {
	size: number;
	default_branch: string;
}

interface TreeEntry {
	path: string;
}

function apiHeaders(): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-web-access",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

async function apiFetch<T>(path: string): Promise<T | null> {
	try {
		const res = await fetch(`${GITHUB_API_BASE}${path}`, { headers: apiHeaders() });
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

async function rawFetch(url: string, maxBytes?: number): Promise<string | null> {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "pi-web-access" },
		});
		if (!res.ok) return null;
		const text = await res.text();
		if (maxBytes && text.length > maxBytes) {
			return text.slice(0, maxBytes) + "\n\n[Content truncated]";
		}
		return text;
	} catch {
		return null;
	}
}

export async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
	const info = await apiFetch<RepoInfo>(`/repos/${owner}/${repo}`);
	if (!info) return null;
	return info.size; // size is in KB
}

async function getDefaultBranch(owner: string, repo: string): Promise<string | null> {
	const info = await apiFetch<RepoInfo>(`/repos/${owner}/${repo}`);
	return info?.default_branch ?? null;
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	const data = await apiFetch<{ tree: TreeEntry[] }>(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
	if (!data?.tree) return null;

	const paths = data.tree.map((e) => e.path);
	if (paths.length === 0) return null;

	const truncated = paths.length > MAX_TREE_ENTRIES;
	const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
	return truncated ? display + `\n... (${paths.length} total entries)` : display;
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	const readme = await apiFetch<{ content: string; encoding: string }>(`/repos/${owner}/${repo}/readme?ref=${ref}`);
	if (!readme?.content) return null;
	try {
		const decoded = Buffer.from(readme.content, "base64").toString("utf-8");
		return decoded.length > 8192 ? decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : decoded;
	} catch {
		return null;
	}
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	// Prefer raw.githubusercontent.com to avoid API rate limits for file content
	const rawUrl = `${GITHUB_RAW_BASE}/${owner}/${repo}/${ref}/${path}`;
	const raw = await rawFetch(rawUrl, MAX_INLINE_FILE_CHARS);
	if (raw !== null) return raw;

	// Fallback to API contents endpoint (handles symlinks, LFS pointers, large files)
	const file = await apiFetch<{ content: string; encoding: string }>(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
	if (!file?.content) return null;
	try {
		return Buffer.from(file.content, "base64").toString("utf-8");
	} catch {
		return null;
	}
}

export async function fetchViaApi(
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
): Promise<ExtractedContent | null> {
	const ref = info.ref || (await getDefaultBranch(owner, repo));
	if (!ref) return null;

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		const content = await fetchFileViaApi(owner, repo, info.path, ref);
		if (!content) return null;

		lines.push(`## ${info.path}`);
		lines.push(content);

		return {
			url,
			title: `${owner}/${repo} - ${info.path}`,
			content: lines.join("\n"),
			error: null,
		};
	}

	const [tree, readme] = await Promise.all([
		fetchTreeViaApi(owner, repo, ref),
		fetchReadmeViaApi(owner, repo, ref),
	]);

	if (!tree && !readme) return null;

	if (tree) {
		lines.push("## Structure");
		lines.push(tree);
		lines.push("");
	}

	if (readme) {
		lines.push("## README.md");
		lines.push(readme);
		lines.push("");
	}

	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return {
		url,
		title,
		content: lines.join("\n"),
		error: null,
	};
}
