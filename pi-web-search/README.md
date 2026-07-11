# pi-web-search

Web search, URL fetching, and code search backed by the 0x010 MCP Web Research gateway.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.

## Requirements

- 0x010 runtime running on `http://127.0.0.1:8000`.
- MCP gateway enabled at `/mcp` (`MCP_ENABLED=true` in `.env`).

## Commands

| Command | Description |
|---------|-------------|
| `/web [on\|off]` | Toggle web tools on/off. Without argument toggles current state. |
| `/web-status` | Check whether the 0x010 web research backend is reachable. |

## Tools

| Tool | When to use |
|------|-------------|
| `web_search` | Current information, docs, discussions, URLs. |
| `fetch_content` | Read a specific URL or list of URLs in markdown. |
| `code_search` | Programming questions, API usage, code examples. |

By default, web tools are disabled: the agent has no web tools at all. Run `/web` (or `/web on`) to enable `web_search`, `fetch_content`, and `code_search`; they become available on the next turn. `/web off` removes them again.

## Configuration

Override the backend URL via environment variables:

- `PI_WEB_SEARCH_URL` — base URL of the 0x010 runtime (default: `http://127.0.0.1:8000`).
- `PI_WEB_SEARCH_MCP_PATH` — MCP mount path (default: `/mcp`; `/mcp/` also works).
