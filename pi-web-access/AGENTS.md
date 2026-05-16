# pi-web-access — session handoff notes

## What was done

### Removed (cut from codebase)
- **Video/YouTube** — `video-extract.ts`, `youtube-extract.ts`, ffmpeg/yt-dlp deps removed
- **Gemini API** — `gemini-api.ts`, `gemini-url-context.ts` removed. Only **Gemini Web** (browser cookies) remains
- **Perplexity** — `perplexity.ts` fully removed
- **Curator** — `curator-server.ts`, `curator-page.ts`, `summary-review.ts` removed. No browser UI, no summary-review workflow
- **Commands** — `/websearch`, `/curator`, `/google-account` removed
- **Glimpse** — macOS window code removed
- **Shortcuts** — `registerShortcut` removed; activity monitor now via `/pi-web-activity` command

### What remains
- `web_search` — auto-select: Exa MCP → Gemini Web fallback
- `fetch_content` — HTTP → Readability → RSC → Jina Reader → Gemini Web fallback
- `code_search` — Exa MCP (zero-config)
- `get_search_content` — retrieve stored results
- `/search` — browse stored results interactively
- `/pi-web-activity` — toggle activity monitor widget on/off

### Provider auto-select chain
```
auto:
  1. Exa (MCP if no key, direct API if EXA_API_KEY set)
  2. Gemini Web (if Chrome cookies available)
```

### Binary garbage filter
`exa.ts` has `isLikelyBinaryGarbage()` that drops results with >2% control chars or `�` (replacement character).

## Files worth checking
- `index.ts` — main extension, tool definitions, commands, widget
- `gemini-search.ts` — search orchestrator, fallback chain, `SearchResult`/`SearchResponse` types
- `exa.ts` — Exa MCP + direct API, binary filter, budget tracking
- `gemini-web.ts` — cookie-based Gemini Web client
- `extract.ts` — HTTP fetch pipeline, fallback orchestration
- `activity.ts` — activity monitor entries and rate-limit tracking
- `storage.ts` — session-aware result storage
- `package.json` — deps: readability, linkedom, turndown, p-limit, unpdf

## Config file
`~/.pi/web-search.json` — optional keys:
- `exaApiKey` / `EXA_API_KEY` env
- `allowBrowserCookies: true` (for Gemini Web)
- `chromeProfile` (if multiple Chrome profiles)
