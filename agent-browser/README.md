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
| `browser_help` | load skill help (`core`, `network`, `state`, `debug`) |

## State

Per-session only. Custom session entries with `customType: "agent-browser-state"`.
No global config file is written.

## Using your own Chrome

By default `agent-browser` launches its own bundled Chromium with a clean profile.
To reuse your logged-in Chrome session, launch Chrome with a separate user-data dir
and remote debugging port, then tell the extension to connect to it.

### Why a separate user-data dir is required

Chrome 136+ on Windows blocks `--remote-debugging-port` when the profile is in the
default location (`%LOCALAPPDATA%\Google\Chrome\User Data`). A separate profile
inside that directory is not enough. See `BROWSER-INTEGRATION.md` for details.

### Launch Chrome

Use the launcher in `C:\chrome-main`:

- `Start Chrome Agent.bat`
- `Start Chrome Agent.ps1`
- `Start Chrome Agent.lnk` (desktop shortcut)

Or run directly:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="C:\chrome-main" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=*
```

Log into the sites you need in that Chrome window.

### Connect from the extension

Pass `cdp_url` to any browser tool to attach to the running Chrome:

```text
browser action:open url:https://grok.com cdp_url:http://127.0.0.1:9222/
```

### Manual check with agent-browser CLI

```bash
agent-browser connect http://127.0.0.1:9222/
agent-browser snapshot -i
```

> Note: `agent-browser --cdp <url>` does **not** attach to an already-running Chrome.
> Use `agent-browser connect <url>` first.
