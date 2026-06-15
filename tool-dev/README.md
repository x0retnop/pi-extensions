# tool-dev

Interactive inspector for everything the LLM sees.

## Usage

Run a single command:

```
/inspect
```

A TUI menu opens with these options:

- **Tools — brief** — active tools grouped by source, with one-line descriptions and parameter summary.
- **Tools — full** — all registered tools with source, path, prompt guidelines, and full JSON schemas.
- **Prompts — brief** — system prompt size, guidelines, skills, context files, and message counts.
- **Prompts — full** — full system prompt, system-prompt options, and formatted conversation history.
- **Other** — current model, thinking level, cwd, context usage, registered slash commands, and last provider payload keys.
- **Full report** — everything above in one document.

The chosen report opens in Pi's built-in editor so you can scroll, copy, and read it without temp files.

## Headless / print mode

If the UI is unavailable, `/inspect` writes a brief report to a temp markdown file and prints the path.

## How it captures data

The extension listens to Pi events:

- `before_agent_start` — last user prompt, system prompt, and system-prompt options.
- `context` — messages that will be sent to the LLM.
- `before_provider_request` — raw provider payload summary.

When you run `/inspect`, the live system prompt and its construction options are refreshed on the spot.

## Install

Copy the extension folder to `~/.pi/agent/extensions/` and restart Pi.
