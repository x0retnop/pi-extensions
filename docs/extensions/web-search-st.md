# web-search-st

Standalone keyless web search + URL fetch. No backend service. Own provider
chain (Exa MCP free tier → Brave/Tavily if keyed → Bing HTML).

## Do not load next to `pi-web-search`

`pi-web-search` is archived (`_archive/pi-web-search.zip`). It shares tool names
(`web_search`, `fetch_content`), the `/web` command, and the session custom type
`web-access-state`; loading both would make them call `setActiveTools()` and fight.
Live runtime has `web-search-st` only — swap, do not stack.

## What it does

- Tools start from `settings.json` `webSearchSt.enabled` (default **off**).
  `/web on|off` writes both the session custom entry and that default.
  A branch with its own `web-access-state` wins over the default.
- Re-synced on `session_start` / `session_tree`.
- No LLM summarization. Agent reads sources itself.
- Two-step flow: `web_search` → `fetch_content`.

## Settings (`~/.pi/agent/settings.json` → `webSearchSt`)

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Default for new sessions / branches with no custom entry |
| `fallback` | `true` | Walk the chain on empty/error. Tool `fallback` overrides per call |
| `chain` | `["exa","brave","tavily","bing"]` | Order. Unknown names dropped |
| `disabled` | `[]` | Providers not tried at all |
| `browserFallback` | `true` | Last fetch hop: render in the user's live Chrome via `C:/tools/agent-browser/fetch.py` |
| `braveKey` / `tavilyKey` | omitted | Saved keys. `BRAVE_API_KEY` / `TAVILY_API_KEY` env win when set |

Keys are stored in plaintext in settings.json (same as Pi provider keys).
TUI shows `****last4` and source (`env` / `saved` / empty). Empty input
clears the saved key, not the env var.

## Fallback rules

Per query (queries run in parallel), walk enabled providers in `chain` order:

1. **Disabled** — not in the walk.
2. **No key** (`isAvailable()=false`) — skip, **not** fallback.
3. **429** — record, skip that provider for the rest of this call, next provider.
4. **Other error / empty** — next provider.
5. **≥1 result** — stop. Fallback only if this was not the first *available* provider.
6. Tool `fallback: false` (or settings `fallback: false` when omitted) — stop after the first available attempt, even if empty/error.

Forced `provider` moves that name first, then the rest (unless fallback is off).

Agent markdown ends with one provenance line:

- success: `_via exa · 5 results_`
- fallback: `_via bing · 5 results · fallback: exa 429_`
- none: `No results found.` + `exa: 429 · bing: empty`

TUI `renderResult`: `5 sources via bing · fallback: exa 429`. Do not retry a
provider the footer just marked 429.

Row, both tools: while the call runs there is one line — `searching…` / `fetching…`, taken from the
single `onUpdate` phase the tools emit (`progressLine` in `index.ts`). It used to be dropped, so a
search, or a fetch waiting on the Chrome hop (~30 s), showed nothing until the finished block landed
in one jump. Collapsed result is one summary line (`12 sources via brave+exa · fallback: exa 429` /
`3 URL(s) fetched · limit 12000 chars · 1 truncated · 1 failed`); Ctrl+O adds the per-result list,
snippets for search, and the saved-content paths. A failed call comes back with `isError: true` —
error-coloured row and an error flag for the model. While the arguments stream the call line reads
`search ...` / `fetch ...`; the red `(no query)` / `(no URL)` is only for a call whose arguments
arrived without one.

## Tool behavior

### `web_search`

- `queries` (2–4) run **in parallel**, interleave, then canonical-URL dedup.
- `num_results` is a **cap on the merged list** (wins over `depth`: quick=5, standard=10, deep=15).
- `recency_filter` / `domain_filter`: brave/tavily honor both; bing honors `site:`;
  Exa ignores both. Multiple `domain_filter` includes are OR
  (`site:a.com OR site:b.com`), not AND. Auto chain then prefers providers
  that honor the filter (Exa last). Forced `provider` still wins.
- Results are a **numbered** list so the agent can fetch by index.
- Snippets are HTML-stripped (Brave returns `<strong>` / `&#x27;`). Brave also
  requests `extra_snippets` and folds them into the snippet (cap 1000).

### `fetch_content`

- Chain: **Jina Reader → Exa** (only if Exa is enabled in `/web`) **→ curl+HTML → browser**
  (only if `browserFallback`, needs Chrome on `127.0.0.1:9222`; skipped silently when down).
  Exa is after Jina so search quota (~1000/mo) is not burned on every page.
  Jina uses UA `pi-web-search-st/0.1` — a Chrome UA gets Cloudflare
  "Just a moment…" 403. A Jina `Warning: Target URL returned error 403`
  is a failed hop, not a page. Exa crawl errors (`Error fetching URL` /
  `CRAWL_HTTP_*` as the body, not a mention in a real page) are failures,
  so the chain continues.
- GitHub `/blob/` → raw.githubusercontent (plain text kept — no
  `normalizeText`) → Jina → github HTML. Other GitHub pages (issues, PRs)
  start at Jina — GitHub HTML is chrome.
- Multi-URL calls run **in parallel**.
- `max_chars` default **16000**, min 1000. Overflow is **always** written as
  cleaned markdown to `%TEMP%/fetch_<hash16>.md`. The tool result tells the
  agent to `read` that file — do not re-fetch with a higher cap.
- No `save_full` flag (always on when truncated). No in-process fetch cache.
- Browser hop: spawns `python C:/tools/agent-browser/fetch.py <url>` (one JSON line on
  stdout, full markdown in `%TEMP%/fetch_browser_<hash>.md`; header `# title\nURL:` stripped
  before `packResult`). 60 s timeout. Exit 2 = anti-bot challenge: the tab is left open
  for the user to solve; the agent is told to re-fetch after the user solves it (or
  `fetch.py --from-tab <host>` for manual extraction). A challenge that auto-passes
  later (managed CF) means a plain re-fetch of the same URL usually succeeds.

## Non-obvious

- **curl.exe, not Node fetch**, for Exa and page fetch. Cloudflare JA3/JA4
  403s undici/`node:https` on `mcp.exa.ai`. Bing is not CF-fronted → Node fetch.
- **Exa needs the SOCKS proxy env**: direct connections to `mcp.exa.ai` from this
  host get connection-reset (~20 s); with `HTTPS_PROXY=socks5://127.0.0.1:10808`
  it answers in ~1 s. Pi inherits the env from its parent shell — if Pi is started
  without it, Exa hops just time out and the chain moves on (verified 2026-10).
- **Exa fetch is their crawl index, not a live crawler**: pages already indexed
  come back clean (26K on a wiki article); fresh/niche URLs are *silently dropped*
  from the response block list → extension sees "Exa empty" and falls through.
  This is the main reason fetch quality varies per URL, and the gap the browser
  hop now covers. Keyless MCP = no key, no account, no visible usage counters;
  rate limits are server-side per IP/fingerprint.
- HTTP status comes from curl `-w %{http_code}`. Parsing the `-D` header file
  with `parseInt` yields 0 (`"HTTP/1.1 200 OK"`).
- Jina/Exa/direct can return a Cloudflare challenge **as 200 content** (Jina markdown
  `Title: Just a moment…`, curl gets the challenge HTML). All three hops reject on
  title match `just a moment|attention required|performing security verification`
  so the browser hop gets its turn.
- Jina Cloudflare 403 on a Chrome UA; use a short client UA for `r.jina.ai`.
- Exa is keyless on `https://mcp.exa.ai/mcp` (protocol `2025-06-18`, session
  id in `mcp-session-id` response header). Free tier ~1000/mo.
- TUI is a `ctx.ui.select` loop (do not nest `select` inside `ui.custom`).
