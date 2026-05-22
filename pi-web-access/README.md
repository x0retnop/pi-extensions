# Pi Web Access

Web search, URL fetching, and code search for Pi. Zero-config Exa MCP search with optional Gemini Web fallback.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. For direct Exa API access or Gemini Web fallback, add keys to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "allowBrowserCookies": true
}
```

## Tools

| Tool | Description |
| --- | --- |
| `web_search` | Search the web via Exa or Gemini Web. Returns a synthesized answer with source citations. Prefer `{queries: [...]}` with 2-4 varied angles. |
| `fetch_content` | Fetch URL(s) as markdown. Handles GitHub repos (clone or API view), PDFs, and regular pages with Jina Reader / Gemini Web fallback. |
| `code_search` | Search for code examples and docs via Exa MCP. No API key required. |
| `get_search_content` | Retrieve stored content from a previous `web_search` or `fetch_content` call via `responseId`. |

## Commands

| Command | Description |
| --- | --- |
| `/search` | Browse stored search results interactively. |
| `/pi-web-activity` | Toggle the web search activity monitor widget on or off. |

## Behavior

- `web_search` tries Exa (MCP if no key, direct API if `EXA_API_KEY` is set), then falls back to Gemini Web when browser cookies are available.
- `fetch_content` routes GitHub URLs to clone or API view, PDFs to text extraction, and HTML through Readability → RSC parser → Jina Reader → Gemini Web fallback.
- GitHub repos are cloned locally when possible; otherwise a lightweight API view is returned. Private repos require the `gh` CLI.
- Results are stored per session and can be retrieved with `get_search_content`.

## Settings

Config lives in `~/.pi/web-search.json`. All fields are optional.

```json
{
  "exaApiKey": "exa-...",
  "allowBrowserCookies": false,
  "chromeProfile": "Profile 2"
}
```

- `allowBrowserCookies` — enables Chromium cookie extraction for Gemini Web. Defaults to `false`.
- `chromeProfile` — Chromium profile directory for cookie lookup.
- `EXA_API_KEY` env var takes precedence over the config file.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

- PDF extraction is text-only; no OCR for scanned documents.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.
- Rate limits: content fetches run 3 concurrent with a 30s timeout per URL.
