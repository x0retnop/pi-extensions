# pi-web-search

Web search, fetch, and code search through the 0x010 backend via MCP.

## What it does

- Registers `web_search`, `fetch_content`, `code_search` tools when enabled.
- When disabled, no web tools are visible to the agent at all.
- Talks to the 0x010 backend over HTTP (`/api/web_research/*`) and MCP (`/mcp`).

## Commands

- `/web` — toggle web tools on/off.
- `/web on|off` — set state directly.
- `/web-status` — check backend reachability and default provider.

## Tools

### `web_search`

General web search. Key behaviors (implemented backend-side):

- `queries` with 2+ entries run **in parallel** and merge with canonical-URL dedup (tracking params / `www.` / fragments normalized).
- Result count: `depth` presets (`quick` = 5, `standard` = 10, `deep` = 15) apply only when `num_results` is not set; an explicit `num_results` always wins. The extension forwards only explicitly set values.
- `raw: true` skips the backend LLM summary for the call (faster, no synthesis tokens) regardless of server `llm_mode`.
- `include_content: true` renders full page text inline (capped at 4000 chars/page); only exa supports it and is auto-preferred by the backend when set.
- `summarize` / `answer_mode` force the respective synthesis mode; with server `llm_mode=summary` a bullet summary is produced by default.
- Snippets are capped at 1500 chars.
- The markdown ends with a provenance footer (`_via exa · 10 results · 2.3s · fallback_`); when all providers fail, their errors are shown inline instead of a bare "No results found".

### `fetch_content`

- `max_chars` default 32000 per page (min 1000).
- GitHub `/blob/` URLs are fetched raw by the backend.
- `save_full: true` + truncated page → backend writes full markdown to `%TEMP%` and appends the path plus an RFC-compliant `file:///...` curl command to the content (no extension-side block).
- `force_clone` is not exposed (reserved, unimplemented).

### `code_search`

- `focus`: `auto` (default, inferred from query), `code` (docs+repos), `docs` (official documentation), `repos` (adds `site:github.com OR site:gitlab.com`).
- `raw: true` skips backend synthesis.
- Code-friendly provider order by default (exa → brave → ollama_cloud → ddg).
- Output capped at `max_tokens * 4` chars, truncated at whole-result boundaries.

## Important behaviors

- **State is per session branch.** The extension stores `web-access-state` custom entries and re-syncs tools on `session_start` / `session_tree`.
- **Backend URL resolution**: `PI_WEB_SEARCH_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.
- **MCP path**: `PI_WEB_SEARCH_MCP_PATH` → `/mcp`.
- Provider chain and defaults come from the backend status endpoint; the backend decides fallback.
- Backend synthesis runs through the infer-gateway; prompt/preset definitions live in `0x010/prompts/web_research/{summary,answer}.md` (currently model alias `Qwen3.5-Qwopus-9B-Q8_0`).

## State

- Custom session entries with `customType: "web-access-state"`.

## Dependencies

- 0x010 backend with web research module enabled.
- Can be toggled off by `context-guard` if a `webAccess` tool gate is added in the future; currently managed only by `/web` and session state.

## Source

- `pi-web-search/index.ts`
- Backend: `0x010/app/web_research/` (spec: `0x010/docs/reference/MCP_WEB_RESEARCH_SPEC.md`)
