# Browser tools map

Use these Pi tools to control the browser via `agent-browser`.

| Tool | When to use |
|---|---|
| `browser` | Core automation: open, snapshot, click, fill, type, eval, screenshot, close, wait. |
| `browser_network` | Mock/block traffic or inspect requests (route, unroute, requests, HAR). |
| `browser_state` | Manage cookies, web storage, and saved auth state. |
| `browser_debug` | Read console/errors, capture traces, inspect React, measure vitals. |
| `browser_help` | Load this skill map or topic help (`web_automation`, `network`, `state`, `debug`). |

## Activation

Browser tools are **off by default**. Enable them with `/browser` TUI.
`browser_help` appears only when at least one browser tool is enabled.

## Core workflow

1. `browser action:open url:...`
2. `browser action:snapshot interactive:true`
3. Use `@eN` refs from the snapshot for click/fill/type.
4. Re-snapshot after any navigation or dynamic change.
5. `browser action:close` when done.

## Sessions

Pass `session` to any tool to isolate browsers. Default session is `default`.
Always close sessions to free resources.
