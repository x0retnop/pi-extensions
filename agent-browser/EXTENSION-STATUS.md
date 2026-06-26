# agent-browser extension — status

## Purpose

Wrap the `agent-browser` CLI as gated Pi tools. The agent can automate a real browser, but only after the user explicitly enables the tools per session.

## What is implemented

- Extension entry point: `index.ts`
- Session-only state stored as `agent-browser-state` custom entries
- `/browser` TUI for toggling tool groups
- 5 registered tools:
  - `browser` — open, snapshot, click, fill, type, eval, screenshot, close, wait, navigate
  - `browser_network` — route, unroute, requests, har_start, har_stop
  - `browser_state` — cookies, storage, state save/load
  - `browser_debug` — console, errors, trace, react, vitals
  - `browser_help` — loads local skill markdown
- All tools call `agent-browser ... --json` via direct `child_process.spawn` (no shell)
- `cdp_url` parameter on every tool; when provided, `agent-browser connect <cdp_url>` runs first
- Compact skill files (`core`, `network`, `state`, `debug`) plus `promptSnippet`/`promptGuidelines` on each tool
- Tools are **off by default**; `browser_help` is active only when at least one main tool is enabled
- `package.json`, `types.ts`, `config.ts`, `utils.ts`, TUI screen, skill files, README, and project doc
- Added to root `tsconfig.json`; `npm run typecheck` passes

## How activation works

1. Extension registers all tool definitions on `session_start` and `session_tree`.
2. It reads the latest `agent-browser-state` entry from the session branch.
3. It calls `pi.setActiveTools()` to expose only enabled tools.
4. The `/browser` command opens a checkbox TUI; on save it appends a new state entry and syncs active tools.

## Verified integration workflow (see `BROWSER-INTEGRATION.md`)

- Chrome 149 on Windows blocks `--remote-debugging-port` when using the default `%LOCALAPPDATA%\Google\Chrome\User Data` dir.
- A separate profile inside that dir is **not** enough.
- Copying an existing profile to a new dir breaks cookies/logins because of App-Bound Encryption.
- Working approach: launch Chrome with a fresh non-default `--user-data-dir`, e.g. `C:\chrome-main`, and build the profile there.
- User launchers created in `C:\chrome-main`: `Start Chrome Agent.bat`, `Start Chrome Agent.ps1`, desktop shortcut `Start Chrome Agent.lnk`.
- `agent-browser` must run `connect http://127.0.0.1:9222/` before other commands; `--cdp` does not attach to an already-running Chrome.

## What still needs to be done

1. **Smoke test inside Pi**
   - Copy the extension to `~/.pi/agent/extensions/`, restart Pi, run `/browser`, enable `browser`, then call `browser action:open url:https://example.com`.
   - Then test CDP mode with a running Chrome: `browser action:open url:https://example.com cdp_url:http://127.0.0.1:9222/`.

## Dependencies

- `agent-browser` CLI installed globally and available in PATH
- For CDP mode: user's Chrome launched with `--remote-debugging-port=9222` from a non-default `--user-data-dir` (e.g. `C:\chrome-main`)
