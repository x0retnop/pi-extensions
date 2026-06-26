# agent-browser

Gated wrapper around the `agent-browser` CLI.

## What it does

- Registers four Pi tools: `browser`, `browser_network`, `browser_state`, `browser_debug`.
- Tools are **inactive by default**. Enable them via `/browser` TUI.
- Skills are in `agent-browser/skills/*.md`; read `core.md` first.
- State is stored per session as `agent-browser-state` custom entries.

## Commands

- `/browser` — open the checkbox TUI to toggle tool groups.

## Tools

| Tool | Group | Purpose |
|---|---|---|
| `browser` | Core automation | open, snapshot, click, fill, type, eval, screenshot, close, back, forward, reload, wait |
| `browser_network` | Network interception | route, unroute, requests, har_start, har_stop |
| `browser_state` | Cookies / storage / auth | cookies, cookies_set, cookies_clear, storage_local, storage_session, state_save, state_load |
| `browser_debug` | Debugging / introspection | cdp_url, console, errors, trace_start, trace_stop, react_tree, react_inspect, vitals |

## Important behaviors

- All CLI calls use `agent-browser ... --json` and are spawned directly via `child_process.spawn` (no shell) to avoid `simple-gate` interference.
- Default timeout is 60 seconds.
- The extension does not write files outside the session; no global `agent-browser.json` config.
- Tool descriptions, prompt snippets, and prompt guidelines are kept compact to avoid bloating the system prompt.
- Every browser tool accepts `cdp_url` to attach to an already-running Chrome with remote debugging enabled.

## Sessions

Every tool accepts an optional `session` parameter. If omitted, `agent-browser`
uses its default session. Use distinct session names to isolate parallel workflows.
Always call `browser action:close` when done.

## Reusing your existing Chrome

`agent-browser` downloads and uses its own Chromium by default. To reuse your
logged-in Chrome, launch it with a separate user-data dir and remote debugging
port (see `agent-browser/BROWSER-INTEGRATION.md`), then pass `cdp_url` to any
browser tool:

```text
browser action:open url:https://grok.com cdp_url:http://127.0.0.1:9222/
```

You can also save/load auth state with `browser_state action:state_save` /
`browser_state action:state_load`.

## Source

- `agent-browser/index.ts` — registration, session events, `/browser` command.
- `agent-browser/config.ts` — per-session state helpers.
- `agent-browser/types.ts` — tool keys, labels, hints.
- `agent-browser/utils.ts` — CLI runner, wait parsing, selector helpers.
- `agent-browser/tools/*.ts` — tool definitions.
- `agent-browser/ui/main-screen.ts` — TUI checkbox list.
- `agent-browser/skills/*.md` — local help content.
