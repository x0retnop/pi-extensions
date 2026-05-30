# pi-request-inspector

Capture and inspect exactly what Pi sends to the LLM provider — system prompt, messages, tool definitions, and raw payload — in a clean markdown file.

## Install

Copy `pi-request-inspector` to `~/.pi/agent/extensions/` and restart Pi.

## Usage

- `/inspect` — Save the last captured provider request to `./.pi-inspect/inspect-<timestamp>.md`.
- `/inspect-toggle` — Toggle auto-save. When ON, every request is dumped automatically.

## Output sections

- **Metadata** — timestamp, model, context usage.
- **System Prompt** — full system/developer message.
- **Messages** — numbered list with roles and content.
- **Tools** — name, description, and JSON schema for each active tool.
- **Full Raw Payload** — complete JSON as sent to the provider.
