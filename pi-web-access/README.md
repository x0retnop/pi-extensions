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
| `web_search` | Current information, docs, discussions, URLs. Returns a synthesized answer + source list. Set `includeContent:true` to get full page text inline. |
| `fetch_content` | Read a specific URL or GitHub repo in full. Single-URL calls return the complete page text. GitHub repos are auto-cloned or served via API view. |
| `code_search` | Programming questions: API usage, library examples, debugging. Returns code snippets and docs. Falls back to `web_search` if needed. |

## Commands

| Command | Description |
|---------|-------------|
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
