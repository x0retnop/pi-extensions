# Ollama Cloud Web

Adds web search and web page fetching tools to Pi through the Ollama Cloud API.

## Install

```bash
pi install git:github.com/x0retnop/pi-extension-ollama-cloud-web
```

## Tools

| Tool | Description |
| --- | --- |
| `web_search` | Search the web for current information, official docs, discussions, reviews, and URLs. |
| `web_fetch` | Fetch and extract readable content from a known URL. |

## Behavior

- Exposes `web_search` and `web_fetch` as model-callable tools.
- Uses Ollama Cloud endpoints.
- Limits search results to a safe range.
- Truncates long fetched/search output for readability.

## Authentication

The extension looks for an Ollama API key in this order:

1. Pi's Ollama auth storage, when available.
2. `OLLAMA_API_KEY` environment variable.
3. `~/.pi/agent/auth.json` with `ollama.key`.

Auth lookup is defensive: if Pi's internal auth storage is unavailable, or `auth.json` cannot be read/parsed, the extension falls back where possible or returns a clear tool error instead of crashing extension loading/event handling.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Notes

This extension follows the public Pi extension API and patterns from the official Pi documentation and examples.
