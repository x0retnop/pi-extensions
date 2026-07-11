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

- `web_search` — general web search.
- `fetch_content` — fetch readable markdown from URLs.
- `code_search` — code-biased search.

## Important behaviors

- **State is per session branch.** The extension stores `web-access-state` custom entries and re-syncs tools on `session_start` / `session_tree`.
- **Backend URL resolution**: `PI_WEB_SEARCH_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.
- **MCP path**: `PI_WEB_SEARCH_MCP_PATH` → `/mcp`.
- Provider chain and defaults come from the backend status endpoint; the backend decides fallback.
- `fetch_content` defaults to `max_chars: 32000`. GitHub `/blob/` URLs are fetched raw by the backend.

## State

- Custom session entries with `customType: "web-access-state"`.

## Dependencies

- 0x010 backend with web research module enabled.
- Can be toggled off by `context-guard` if a `webAccess` tool gate is added in the future; currently managed only by `/web` and session state.

## Source

- `pi-web-search/index.ts`
