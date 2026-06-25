# pi-extension-agent-browser

Gated `agent-browser` CLI wrapper for Pi.

## What it does

- Registers `browser`, `browser_network`, `browser_state`, `browser_debug`, and `browser_help` tools.
- All browser tools are **disabled by default**.
- Use `/browser` TUI to toggle tool groups per session.
- `browser_help` is active only when at least one browser tool is enabled.

## Commands

- `/browser` — open the gate TUI.

## Tools

| Tool | Purpose |
|---|---|
| `browser` | open, snapshot, click, fill, type, eval, screenshot, close, wait |
| `browser_network` | route, unroute, requests, har_start, har_stop |
| `browser_state` | cookies, storage, state_save, state_load |
| `browser_debug` | console, errors, trace_start/stop, react_tree, react_inspect, vitals |
| `browser_help` | load skill help (`map`, `web_automation`, `network`, `state`, `debug`) |

## State

Per-session only. Custom session entries with `customType: "agent-browser-state"`.
No global config file is written.

## Using your own Chrome

`agent-browser` uses its own Chromium by default. To reuse your logged-in Chrome,
pass `extra_args:["--auto-connect"]` to `browser action:open` (Chrome must be
running with remote debugging). Or use `browser_state action:state_load` with a
saved auth JSON.
