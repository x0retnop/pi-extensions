// URL fetch: Jina Reader → Exa MCP (if enabled) → curl.exe + HTML cleanup
// → user's live Chrome via agent-browser/fetch.py (JS/cookie-wall/anti-bot last resort).
// GitHub /blob/: raw.githubusercontent (plain text kept) → Jina → github HTML.
// Node TLS is fingerprint-blocked on many hosts; all HTTP here is curl.exe.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastContentType, runCurl } from "./curl.js";
import { exaFetchUrl, isExaFetchError, type FetchResult } from "./providers.js";

// Direct fetch keeps a browser UA (some hosts 403 curl's default). Jina's
// Cloudflare challenges that same Chrome UA ("Just a moment…" 403) but
// allows a short client UA — verified 2026-08.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const JINA_UA = "pi-web-search-st/0.1";
const GITHUB_BLOB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i;

/** Default per-page cap returned inline to the agent. Overflow goes to %TEMP%. */
export const DEFAULT_MAX_CHARS = 16000;
/** How much to pull from Exa so the overflow file is actually complete.
 *  Verified 2026-08-19: honored (WWII wiki → 134k; not a ~20k clamp).
 *  Jina of the same page was 476k — Exa extract is shorter, not cap-truncated. */
const EXA_FETCH_CAP = 200_000;
const JINA_TIMEOUT_MS = 25000;
const DIRECT_TIMEOUT_MS = 20000;
const EXA_TIMEOUT_MS = 25000;
const BROWSER_TIMEOUT_MS = 60000;
/** Standalone CDP fetch CLI; stdout is one JSON line, markdown goes to %TEMP%. */
const BROWSER_FETCH_PY = "C:/tools/agent-browser/fetch.py";

export function isGitHubBlobUrl(url: string): boolean {
  return GITHUB_BLOB_RE.test(url);
}

export function githubRawUrl(url: string): string {
  const m = GITHUB_BLOB_RE.exec(url);
  if (!m) return url;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
}

export function isGitHubUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("github.com");
  } catch {
    return false;
  }
}

/** Collapse redundant whitespace while preserving paragraph/structural breaks. */
export function normalizeText(text: string): string {
  let t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  t = t.replace(/\n[ \t]*\n+/g, "\n\n");
  const lines = t.split("\n");
  const paragraphs: string[][] = [];
  let current: string[] = [];

  const isStructuralStart = (line: string): boolean =>
    line.startsWith("-") || line.startsWith("*") || line.startsWith("#") ||
    line.startsWith(">") || line.startsWith("```") || line.startsWith("|") ||
    /^\d+\.[ \t]/.test(line);

  const isStructuralEnd = (line: string): boolean =>
    /^[#]{1,6}\s/.test(line) || line.startsWith("-") || line.startsWith("*") ||
    line.startsWith(">") || line.startsWith("|") || line.startsWith("```") ||
    /^\d+\.[ \t]/.test(line) || line.endsWith(":") || /[.!?;]$/.test(line);

  for (const rawLine of lines) {
    const s = rawLine.trim();
    if (!s) {
      if (current.length) { paragraphs.push(current); current = []; }
      continue;
    }
    if (!current.length) { current.push(s); continue; }
    const prev = current[current.length - 1];
    if (isStructuralStart(s) || isStructuralEnd(prev)) {
      paragraphs.push(current);
      current = [s];
    } else {
      current.push(s);
    }
  }
  if (current.length) paragraphs.push(current);
  return paragraphs.map((p) => p.join(" ")).join("\n\n");
}

/** Minimal HTML→text extraction without a DOM library: strip noise tags,
 *  prefer <main>/<article>/<body>, decode entities. */
export function extractFromHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

  let body = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || body.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (mainMatch) body = mainMatch[1];
  else {
    const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) body = bodyMatch[1];
  }

  const text = body
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");

  return { title, text: normalizeText(text) };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function parseJinaText(text: string): { title: string; body: string } {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const titleMatch = raw.match(/^Title:\s*(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const md = raw.match(/^Markdown Content:\s*\n/m);
  let body: string;
  if (md && md.index !== undefined) {
    body = raw.slice(md.index + md[0].length).trim();
  } else if (raw.startsWith("Title:")) {
    const lines = raw.split("\n");
    let i = 0;
    while (i < lines.length && /^(Title|URL Source|URL|Published Time|Warning):/i.test(lines[i].trim())) i++;
    if (lines[i]?.trim() === "") i++;
    body = lines.slice(i).join("\n").trim();
  } else {
    body = raw;
  }
  return { title: title || "Untitled", body };
}

export function classifyFetchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate limited/i.test(msg)) return "429";
  if (/timeout|aborted|ETIMEDOUT|AbortError/i.test(msg)) return "timeout";
  const http = msg.match(/HTTP (\d{3})/i);
  if (http) return `HTTP ${http[1]}`;
  return msg.replace(/\s+/g, " ").trim().slice(0, 120);
}

function saveFullContent(url: string, text: string): string | null {
  const tempDir = tmpdir();
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const path = join(tempDir, `fetch_${hash}.md`);
  try {
    writeFileSync(path, text, "utf-8");
    return path;
  } catch {
    return null;
  }
}

/** Cap inline text; on overflow always write the full cleaned page to %TEMP%. */
export function applyOverflow(
  fullText: string,
  maxChars: number,
  url: string,
): { content: string; truncated: boolean; fullContentPath: string | null } {
  if (fullText.length <= maxChars) {
    return { content: fullText, truncated: false, fullContentPath: null };
  }
  const path = saveFullContent(url, fullText);
  const omitted = fullText.length - maxChars;
  const head = fullText.slice(0, maxChars);
  const note = path
    ? `\n\n[Returned ${maxChars} chars (limit ${maxChars}); ${omitted} chars omitted.\n`
      + `Full cleaned markdown: ${path}\n`
      + `Read that file with the read tool for the rest. Do not re-fetch this URL with a higher max_chars.]`
    : `\n\n[Returned ${maxChars} chars (limit ${maxChars}); ${omitted} chars omitted. Failed to save full text to temp.]`;
  return { content: head + note, truncated: true, fullContentPath: path };
}

function packResult(
  url: string,
  title: string,
  fullText: string,
  provider: string,
  statusCode: number | undefined,
  maxChars: number,
): FetchResult {
  const overflow = applyOverflow(fullText, maxChars, url);
  return {
    url,
    title: title || "Untitled",
    content: overflow.content,
    sourceProvider: provider,
    statusCode,
    truncated: overflow.truncated,
    fullContentPath: overflow.fullContentPath,
  };
}

async function curlFetchText(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  userAgent: string = UA,
): Promise<{ status: number; text: string; contentType: string }> {
  const res = await runCurl(url, {
    timeoutMs,
    signal,
    extraArgs: ["-L", "-A", userAgent, "-H", "Accept-Language: en-US,en;q=0.9"],
  });
  return { status: res.status, text: res.body, contentType: lastContentType(res.headers) };
}

/** Cloudflare interstitial — Jina returns this for browser UAs (HTTP 403 or 200). */
export function isCloudflareChallenge(status: number, text: string): boolean {
  if (status === 403 && /just a moment/i.test(text)) return true;
  return /<title>\s*just a moment/i.test(text);
}

/** Jina 200 with a target-error Warning (Reddit 403, etc.). */
export function jinaTargetError(text: string): string | undefined {
  const warn = text.match(/^Warning:\s*(.+)$/m);
  if (!warn) return undefined;
  const msg = warn[1].replace(/\s+/g, " ").trim();
  if (/error\s+\d{3}|forbidden|blocked/i.test(msg)) return msg;
  return undefined;
}

async function jinaFetch(
  url: string,
  maxChars: number,
  signal: AbortSignal | undefined,
): Promise<FetchResult> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const { status, text } = await curlFetchText(jinaUrl, JINA_TIMEOUT_MS, signal, JINA_UA);
  if (status >= 400 || isCloudflareChallenge(status, text)) {
    throw new Error(`Jina HTTP ${status >= 400 ? status : 403}`);
  }
  const targetErr = jinaTargetError(text);
  if (targetErr) {
    const http = targetErr.match(/\b(\d{3})\b/);
    throw new Error(http ? `Jina HTTP ${http[1]}` : `Jina ${targetErr}`);
  }
  const parsed = parseJinaText(text);
  // Jina 200s some Cloudflare challenges as markdown — title gives them away.
  if (/just a moment|attention required|performing security verification/i.test(parsed.title)) {
    throw new Error("Jina challenge page");
  }
  if (!parsed.body.trim()) throw new Error("Jina empty");
  if (/^Warning:/i.test(parsed.body) && parsed.body.length < 240) {
    throw new Error(parsed.body.replace(/\s+/g, " ").trim().slice(0, 120));
  }
  return packResult(url, parsed.title, parsed.body, "jina", status, maxChars);
}

/** Non-HTML (source, json, md): keep bytes. Only normalize newlines. */
export function preservePlainText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function directFetch(
  target: string,
  originalUrl: string,
  provider: string,
  maxChars: number,
  signal: AbortSignal | undefined,
): Promise<FetchResult> {
  const { status, text, contentType } = await curlFetchText(target, DIRECT_TIMEOUT_MS, signal);
  if (status >= 400) throw new Error(`Direct fetch HTTP ${status}`);

  let title = originalUrl;
  let clean = text;
  const isHtml = contentType.includes("text/html") || text.trim().startsWith("<");
  if (isHtml) {
    const extracted = extractFromHtml(text);
    title = extracted.title || originalUrl;
    if (/just a moment|attention required|performing security verification/i.test(title)) {
      throw new Error("Direct fetch challenge page");
    }
    clean = extracted.text;
  } else {
    // Do not run normalizeText: it joins lines and strips indent (source, JSON).
    clean = preservePlainText(text);
  }
  if (!clean.trim()) throw new Error("Direct fetch empty");
  return packResult(originalUrl, title, clean, provider, status, maxChars);
}

async function exaAsResult(
  url: string,
  maxChars: number,
  signal: AbortSignal | undefined,
): Promise<FetchResult> {
  const fetched = await exaFetchUrl([url], EXA_FETCH_CAP, { timeoutMs: EXA_TIMEOUT_MS, signal });
  if (fetched.length === 0 || !fetched[0].content.trim()) throw new Error("Exa empty");
  const f = fetched[0];
  if (isExaFetchError(f.content)) {
    throw new Error(f.content.replace(/\s+/g, " ").trim().slice(0, 160));
  }
  if (/just a moment|attention required|performing security verification/i.test(f.title ?? "")) {
    throw new Error("Exa challenge page");
  }
  const framed = /^#\s.+\nURL:\s/m.test(f.content);
  const full = framed ? f.content : `# ${f.title}\nURL: ${url}\n\n${f.content}`;
  return packResult(url, f.title, full, "exa", 200, maxChars);
}

export interface FetchPageOptions {
  maxChars: number;
  signal?: AbortSignal;
  exaEnabled: boolean;
  browserEnabled?: boolean;
}

interface BrowserFetchMeta {
  ok?: boolean;
  challenge?: boolean;
  error?: string;
  title?: string;
  final_url?: string;
  path?: string;
  status?: number | null;
  engine?: string;
}

function runFetchPy(url: string, signal?: AbortSignal): Promise<BrowserFetchMeta> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = execFile(
      "python",
      [BROWSER_FETCH_PY, url],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: BROWSER_TIMEOUT_MS },
      (err, stdout) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (err && (err as { killed?: boolean }).killed) {
          reject(new Error("browser fetch timeout"));
          return;
        }
        const line = stdout.trim().split("\n").pop() ?? "";
        try {
          resolve(JSON.parse(line) as BrowserFetchMeta);
        } catch {
          reject(new Error(`browser fetch bad output (exit ${err ? String(err.message).slice(0, 60) : "?"})`));
        }
      },
    );
    const onAbort = () => {
      try { child.kill(); } catch { /* already exited */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function browserAlive(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await runCurl("http://127.0.0.1:9222/json/version", {
      timeoutMs: 1500,
      signal,
      extraArgs: ["--noproxy", "*"],
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Last hop: render in the user's real Chrome (profile cookies, SOCKS). */
async function browserFetch(
  url: string,
  maxChars: number,
  signal: AbortSignal | undefined,
): Promise<FetchResult> {
  if (!(await browserAlive(signal))) throw new Error("chrome unreachable (127.0.0.1:9222)");
  const meta = await runFetchPy(url, signal);
  if (!meta.ok) {
    if (meta.challenge) {
      throw new Error("browser anti-bot challenge — tab left open in Chrome; solve it and re-fetch");
    }
    throw new Error(`browser: ${(meta.error ?? "failed").slice(0, 100)}`);
  }
  if (!meta.path) throw new Error("browser: no output file");
  let text: string;
  try {
    text = readFileSync(meta.path, "utf-8");
  } catch {
    throw new Error("browser: cannot read temp output");
  }
  // fetch.py frames the file with "# title\nURL: ...\n\n"; packResult frames itself.
  const body = text.replace(/^#\s[^\n]*\nURL:\s[^\n]*\n\n/, "");
  if (!body.trim()) throw new Error("browser: empty extraction");
  return packResult(url, meta.title ?? "Untitled", body, "browser", meta.status ?? 200, maxChars);
}

/** One URL through the strategy chain. Throws only when every hop failed. */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<FetchResult> {
  const target = url.trim();
  if (!target) throw new Error("URL is required");

  const attempts: string[] = [];
  const tryOne = async (name: string, fn: () => Promise<FetchResult>): Promise<FetchResult | null> => {
    try {
      const r = await fn();
      r.attempts = [...attempts, `${name} ok`];
      return r;
    } catch (err) {
      attempts.push(`${name} ${classifyFetchError(err)}`);
      return null;
    }
  };

  if (isGitHubBlobUrl(target)) {
    const raw = await tryOne("github_raw", () =>
      directFetch(githubRawUrl(target), target, "github_raw", options.maxChars, options.signal));
    if (raw) return raw;
    const jina = await tryOne("jina", () => jinaFetch(target, options.maxChars, options.signal));
    if (jina) return jina;
    const html = await tryOne("github_html", () =>
      directFetch(target, target, "github_html", options.maxChars, options.signal));
    if (html) return html;
    throw new Error(`All fetch strategies failed for ${target}: ${attempts.join("; ")}`);
  }

  const jina = await tryOne("jina", () => jinaFetch(target, options.maxChars, options.signal));
  if (jina) return jina;

  if (options.exaEnabled) {
    const exa = await tryOne("exa", () => exaAsResult(target, options.maxChars, options.signal));
    if (exa) return exa;
  }

  const directName = isGitHubUrl(target) ? "github_html" : "direct";
  const direct = await tryOne(directName, () =>
    directFetch(target, target, directName, options.maxChars, options.signal));
  if (direct) return direct;

  if (options.browserEnabled) {
    const browser = await tryOne("browser", () =>
      browserFetch(target, options.maxChars, options.signal));
    if (browser) return browser;
  }

  throw new Error(`All fetch strategies failed for ${target}: ${attempts.join("; ")}`);
}
