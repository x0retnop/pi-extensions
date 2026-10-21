# web-search-st

Standalone, keyless web search and URL fetch for Pi — no backend service, no
mandatory API keys. A standalone rework of `pi-web-search` (now archived to
`Inactive/pi-web-search.zip`) with its own provider layer replacing the MCP gateway.

## Install

Copy the folder to `~/.pi/agent/extensions/` and restart Pi.

Do **not** resurrect `pi-web-search` next to it — same tool names (`web_search`,
`fetch_content`), `/web`, and `web-access-state`. It is archived; load only one.

## Requirements

- Windows 10+ with `curl.exe` (built-in since 1803) — used for Exa MCP and
  direct page fetch because Node's TLS stack is fingerprint-blocked by
  Cloudflare on those hosts.
- Nothing else. No backend, no registration, no mandatory keys.

## Optional keys

- `TAVILY_API_KEY` / `BRAVE_API_KEY` env, **or** paste in `/web` TUI
  (saved in `settings.json` → `webSearchSt`). Env wins when set.
- Without keys the live chain is `exa → bing`.

## Provider chain

| Provider | Key | Quality | Notes |
|----------|-----|---------|-------|
| `exa` | no | best | Exa MCP free tier (`mcp.exa.ai/mcp`), ~1000 req/mo, rate-limited. No recency/domain filters via MCP. |
| `brave` | `BRAVE_API_KEY` | high | API. Honors `recency_filter` (freshness) and `site:` domain filter. |
| `tavily` | `TAVILY_API_KEY` | high | API. Honors `recency_filter` (days) and include/exclude domains. |
| `bing` | no | ok | HTML scrape, no key. Honors `site:` domain filter. |

Default order (auto): `exa → brave → tavily → bing`. Reorder / disable in
`/web`. No-key providers are skipped (not counted as fallback). Empty result
or error (including 429) walks the next provider. Quality-first.

## Commands

| Command | Description |
|---------|-------------|
| `/web` | Settings TUI: on/off, keys, chain, fallback. |
| `/web on\|off` | Set this session + default for new sessions. |
| `/web-status` | Same TUI as `/web`. |

## Tools

| Tool | Description |
|------|-------------|
| `web_search` | Multi-query search with URL dedup across the provider chain. No LLM summarization — the agent reads and synthesizes the sources itself. |
| `fetch_content` | URL → markdown. Jina → Exa (if enabled) → curl+HTML. GitHub `/blob/` → raw (plain text kept) → Jina → github HTML. Overflow past 16k is saved to `%TEMP%` for `read`. Jina UA is `pi-web-search-st/0.1` (Chrome UA is CF-challenged). |

### web_search parameters

- `query` / `queries` — single or 2–4 parallel phrasings. Multi-query results interleave, then dedup, then cap.
- `num_results` / `depth` — cap on the merged list (default by depth: 5/10/15).
- `recency_filter` — `day|week|month|year`; honored by brave/tavily only.
- `domain_filter` — e.g. `["docs.python.org"]` or `["-medium.com"]`; multiple includes are OR. Honored by brave/tavily/bing.
- `provider` — `auto` (default chain) or force one: `exa|brave|tavily|bing`.
- `fallback` — default from settings (usually `true`); `false` stops after the
  first available provider.

The last markdown line is provenance (`_via exa · 5 results_` or
`_via bing · 5 results · fallback: exa 429_`). `/web` remembers last on/off
as the default for new sessions (`webSearchSt.enabled`).

## Architecture

- `index.ts` — tools, commands, session on/off.
- `tui.ts` / `settings.ts` — `/web` menu; `webSearchSt` in settings.json.
- `providers.ts` — chain, Exa MCP, Bing/Tavily/Brave, URL dedup, fallback trail.
- `fetcher.ts` — direct fetch via curl.exe + HTML cleanup + GitHub raw mapping.
- `curl.ts` — shared curl.exe helper; HTTP status from `-w %{http_code}`.

### Why curl.exe for Exa and direct fetch

Cloudflare applies a TLS-fingerprint filter (JA3/JA4): Node's built-in fetch
(undici) and `node:https` both get stable HTTP 403 from `mcp.exa.ai`, while
curl.exe and Python httpx pass. Verified 5×5 on 2026-08. Bing is not
Cloudflare-fronted and works via plain `fetch`.

## Notes

- Exa free tier is rate-limited; on 429 the chain falls back to the next
  provider and the tool output notes it.
- Multi-URL `fetch_content` runs URLs in parallel; per-page errors stay isolated.
- Pages longer than `max_chars` (default 16000) write cleaned markdown to
  `%TEMP%/fetch_<hash16>.md`. The agent should `read` that file, not re-fetch.
- `web_search` does not fetch page content (`include_content` is gone) — use
  the two-step `web_search` → `fetch_content` flow instead.
- `recency_filter` / `domain_filter` move Exa last on auto chain (it ignores both).
