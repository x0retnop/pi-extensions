# pi-web-access — session handoff notes

## What was done

### Removed (cut from codebase)
- **Video/YouTube** — `video-extract.ts`, `youtube-extract.ts`, ffmpeg/yt-dlp deps removed
- **Gemini API** — `gemini-api.ts`, `gemini-url-context.ts` removed. Only **Gemini Web** (browser cookies) remains
- **Perplexity** — `perplexity.ts` fully removed
- **Curator** — `curator-server.ts`, `curator-page.ts`, `summary-review.ts` removed. No browser UI, no summary-review workflow
- **Commands** — `/websearch`, `/curator`, `/google-account` removed
- **Glimpse** — macOS window code removed

### What remains
- `web_search` — auto-select: Exa MCP → Gemini Web fallback
- `fetch_content` — HTTP → Readability → RSC → Jina Reader → Gemini Web fallback
- `code_search` — Exa MCP (zero-config)
- `get_search_content` — retrieve stored results
- `/search` — browse stored results
- `/pi-web-activity` — toggle activity monitor widget (BUG: currently throws `content is not a function`)

### Provider auto-select chain
```
auto:
  1. Exa (MCP if no key, direct API if EXA_API_KEY set)
  2. Gemini Web (if Chrome cookies available)
```

### Binary garbage filter
`exa.ts` has `isLikelyBinaryGarbage()` that drops results with >2% control chars or `�` (replacement character).

## Known bugs

1. **`/pi-web-activity` command crashes with `content is not a function`**
   - Command is registered in `index.ts` via `pi.registerCommand("pi-web-activity", ...)`
   - Error suggests handler return type issue or Pi API mismatch
   - **Fix candidate:** check if handler needs to return void, or if `ctx.ui.notify` call is the problem

2. **Activity widget may not render**
   - `updateWidget()` uses `ctx.ui.setWidget("web-activity", new Text(...))`
   - If Pi expects string instead of `Text` object, widget won't show
   - Previously used shortcut `ctrl+shift+w` (conflicted with system), changed to `ctrl+shift+s`, then replaced with `/pi-web-activity` command

## How to test

```bash
# Basic search (Exa MCP)
web_search({ query: "rust async 2025" })

# Multi-query research
web_search({ queries: ["rust async performance", "rust embedded async no_std", "rust async ecosystem 2025"] })

# With filters
web_search({ query: "TypeScript 5.8", recencyFilter: "year", domainFilter: ["github.com"] })

# Deep research with background fetch
web_search({ query: "topic", includeContent: true, numResults: 10 })

# Fetch specific page
fetch_content({ url: "https://doc.rust-lang.org/..." })

# Code search
code_search({ query: "rust tokio spawn pattern" })

# Retrieve stored content
get_search_content({ responseId: "abc123", urlIndex: 0 })

# Test Gemini Web directly
web_search({ query: "test", provider: "gemini" })

# Activity monitor
/pi-web-activity on
/pi-web-activity off
```

## Files touched / worth checking
- `index.ts` — main extension (~650 lines after cleanup)
- `gemini-search.ts` — search orchestrator, fallback chain
- `exa.ts` — Exa MCP + binary filter
- `gemini-web.ts` — cookie-based Gemini Web + `extractWithGeminiWeb`
- `extract.ts` — HTTP fetch pipeline
- `activity.ts` — activity monitor (widget data source)
- `package.json` — description updated, deps: readability, linkedom, turndown, p-limit, unpdf

## Dependencies
```
npm install @mozilla/readability linkedom turndown p-limit unpdf
```
Installed in `C:\Users\user\.pi\agent\` (shared node_modules for all extensions).

## Config file
`~/.pi/web-search.json` — optional keys:
- `exaApiKey` / `EXA_API_KEY` env
- `allowBrowserCookies: true` (for Gemini Web)
- `chromeProfile` (if multiple Chrome profiles)
