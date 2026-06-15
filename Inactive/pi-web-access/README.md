# pi-web-access

Web search, URL fetching, and code search for the Pi coding agent.

This is a heavily modified fork of the original `pi-web-access` by Nico Bailon. Key changes: Gemini Web support removed (unreliable and broken by upstream changes), Ollama Cloud added as a fallback provider, configuration moved to Pi's native `settings.json`/`auth.json`, and the tool surface was simplified (removed `get_search_content` and background-fetch complexity).

## Install

```bash
pi install ./pi-web-access
```

## Tools

| Tool | When to use |
|------|-------------|
| `web_access` | **Shown only when web access is OFF.** Reminds the user to run `/web` if they asked for web content. |
| `web_search` | Current information, docs, discussions, URLs. Returns a synthesized answer + source list. Set `includeContent:true` to get full page text inline. |
| `fetch_content` | Read a specific URL or GitHub repo in full. Single-URL calls return the complete page text. GitHub repos are auto-cloned or served via API view. |
| `code_search` | Programming questions: API usage, library examples, debugging. Returns code snippets and docs. Falls back to `web_search` if needed. |

By default, `web_search`, `fetch_content`, and `code_search` are **not visible to the agent**. Only `web_access` is active. This keeps the tool list short and reduces context usage. When the user asks for web content, the agent will call `web_access` and remind you to enable access with `/web`. After you run `/web`, the web tools become available on the agent's next turn. Run `/web` again (or `/web off`) to hide them.

## Commands

| Command | Description |
|---------|-------------|
| `/web` | Toggle web search tools on/off. With `on`/`off` argument sets state explicitly. |
| `/web-config provider auto\|exa-mcp\|exa-api\|ollama` | Set search provider. |
| `/web-config exa-key <key>` | Save Exa API key to `auth.json`. |
| `/web-config ollama-key <key>` | Save Ollama Cloud API key to `auth.json`. |
| `/web-config show` | Show current provider and masked keys. |
| `/search` | Browse stored search results interactively. |
| `/pi-web-activity` | Toggle the activity monitor widget. |

## Provider fallback (auto mode)

1. **Exa API** — direct API calls if an API key is configured.
2. **Exa MCP** — zero-config search via Exa's MCP endpoint.
3. **Ollama Cloud** — if an API key is configured.

Set `EXA_API_KEY` or `OLLAMA_API_KEY` env vars, or use `/web-config` to persist keys.

## Configuration

Provider selection is stored in `~/.pi/agent/settings.json` under `piWebAccess.searchProvider`.

API keys are stored in `~/.pi/agent/auth.json` under `exa.key` and `ollama.key`.

## Notes

- `code_search` uses Exa MCP under the hood.
- PDF extraction is text-only; no OCR.
- Content fetches run 3 concurrent with a 30s timeout per URL.

## Credits

- Original: Nico Bailon (`pi-web-access`).
- Modifications: stripped Gemini Web, added Ollama Cloud, rewrote config system, simplified tools.
