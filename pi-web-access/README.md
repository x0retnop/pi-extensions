<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and code search for Pi agent. Zero-config Exa search with optional Gemini Web fallback.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). Add an Exa API key for direct API access, or sign into gemini.google.com in a Chromium-based browser for Gemini Web fallback.

**Smart Fallbacks** — Search tries Exa (MCP or direct API), then falls back to Gemini Web when browser cookies are enabled. Blocked pages retry through Jina Reader and Gemini Web extraction.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. For direct API access or Gemini Web fallback, add keys to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "geminiApiKey": "AIza...",
  "allowBrowserCookies": true
}
```

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Search code examples
code_search({ query: "React useEffect cleanup pattern" })
```

## Tools

### web_search

Search the web via Exa or Gemini Web. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", includeContent: true })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `includeContent` | Fetch full page content from sources in background |

### code_search

Search for code examples, documentation, and API references via Exa MCP. No API key required.

```typescript
code_search({ query: "React useEffect cleanup pattern" })
code_search({ query: "Express middleware error handling", maxTokens: 10000 })
```

| Parameter | Description |
|-----------|-------------|
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Maximum tokens of context to return (default: 5000, max: 50000) |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Automatically detects and handles GitHub repos, PDFs, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL or multiple URLs |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
```

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles JS rendering server-side, no API key needed), then Gemini Web extraction when browser cookies are enabled. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → Exa (direct API with key, MCP without) → Gemini Web (if browser cookies enabled)

fetch_content(url)
  → GitHub URL?  Clone repo, return file contents + local path
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader → Gemini Web fallback
               → Text/JSON/Markdown? Return directly
```

## Commands

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /pi-web-activity

Toggle the web search activity monitor widget on or off.

```
/pi-web-activity          # toggle
/pi-web-activity on       # enable
/pi-web-activity off      # disable
```

## Configuration

All config lives in `~/.pi/web-search.json`. Every field is optional.

```json
{
  "exaApiKey": "exa-...",
  "geminiApiKey": "AIza...",
  "allowBrowserCookies": false,
  "chromeProfile": "Profile 2"
}
```

`EXA_API_KEY` and `GEMINI_API_KEY` env vars take precedence over config file values. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. `chromeProfile` overrides the Chromium profile directory used for Gemini Web cookie lookup.

Rate limits: Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`. On macOS, enabling it may trigger a Keychain dialog; Linux uses `secret-tool` when available and falls back to Chromium's default password otherwise.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands |
| `gemini-search.ts` | Search orchestrator, fallback chain |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy |
| `code-search.ts` | Code/docs search via Exa MCP |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |

</details>
