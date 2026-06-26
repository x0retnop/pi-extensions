# agent-browser extension — progress notes

> This file is for the next agent/session. Read it first before changing anything in `agent-browser/`.

## What this extension does

Wraps the `agent-browser` CLI as gated Pi tools. The user enables tool groups via `/browser`, then the agent can drive a real browser.

Tools:

| Tool | Purpose |
|---|---|
| `browser` | Core automation: open, snapshot, tabs, tab, click, fill, type, eval, screenshot, close, wait |
| `browser_network` | Route/unroute, requests, HAR capture |
| `browser_state` | Cookies, storage, save/load auth state |
| `browser_debug` | Console, errors, traces, React, vitals, cdp_url helper |

All tools are off by default.

## Important design decisions already made

1. **No auto-injection of skills into the system prompt.** The user's `context-guard` has `autoSkills` off, so skill files are NOT injected automatically. The user pastes a short prompt + path to `agent-browser/skills/core.md` before each browser task.

2. **CDP mode uses the user's already-running Chrome.** The user has Chrome running with `--remote-debugging-port=9222`. To attach, the agent must pass `cdp_url:"http://127.0.0.1:9222/"` on **every** browser tool call. Without it, `agent-browser` launches its own bundled Chromium.

3. **`cdp_url` is passed as the global `--cdp` CLI flag**, not via `agent-browser connect`. Earlier we tried `connect` first, but it created a separate bundled-Chromium session. The current implementation in `utils.ts` adds `--cdp <url>` before the command.

4. **Windows executable lookup.** `agent-browser` npm installs as `.cmd`/`.ps1` wrappers plus `agent-browser-win32-x64.exe`. Direct `spawn('agent-browser')` fails on Windows, so `utils.ts` resolves the `.exe` from several locations and stores it in `AGENT_BROWSER_PATH`. All spawns use that path.

5. **Tool call rendering.** Each browser tool now has a `renderCall` that shows the action and key params (cdp_url, selector, URL, etc.) in the TUI, so the user can see what is happening instead of a plain "browser" label.

6. **Skills are intentionally compact.** No 10-line micro-files, no full upstream manual. `core.md` is the main guide (~80 lines); `network.md`, `state.md`, `debug.md` are short topic-specific references.

## What was tested and verified

### CLI-level verification (without the Pi tool layer)

All commands below were run directly in the terminal against the user's live Chrome at `http://127.0.0.1:9222/`.

- `agent-browser connect http://127.0.0.1:9222/ --json` → success.
- `agent-browser tab --json` → listed the user's tabs, including `Standard Runtime Chat`, Grok tabs, Spotify.
- `agent-browser tab t2 --json` → switched to Grok tab.
- `agent-browser snapshot -i --json` → returned accessibility tree with `@eN` refs for Grok UI.
- `agent-browser click @e13 --json` → clicked "Новый чат".
- `agent-browser fill @e82 "Hello from agent-browser via CDP" --json` + `press Enter` + wait → message posted.
- `agent-browser screenshot C:/tmp/grok-cdp-test.png --json` → screenshot confirmed Grok replied.
- `agent-browser --cdp http://127.0.0.1:9222/ open https://example.com --json` → opened in user's Chrome, visible in tab list.

### Code-level verification

- `npm run typecheck` passes.
- `python scripts/run-tests.py` passes (43/43).
- Loaded `agent-browser/utils.ts` in Node with `--experimental-strip-types` and called `runAgentBrowser(['open','https://example.com/'], undefined, 'http://127.0.0.1:9222/')` → returned the opened page, no bundled Chromium launched.

### Pi-level verification

- The user ran a live test in a Pi session. The agent initially failed because:
  1. It did not pass `cdp_url` on every call.
  2. It confused `ws://` CDP URL with the required `http://` URL.
  3. It fell back to `bash` when `spawn('agent-browser')` failed on Windows.
- After fixes, the user confirmed: "гараздо лучше все стало, агент лучше ориентируется и смог потыкать".

## Known remaining gaps / next steps

The user mentioned there are still some things to finish in a follow-up session. Known areas that may need attention:

1. **More graceful handling when the agent forgets `cdp_url`.** Currently without `cdp_url` it launches bundled Chromium. We may want a session-level default or stronger prompting so the agent does not forget.

2. **Snapshot defaults.** We changed `snapshot` from always passing `-i -c -d 1` back to plain `snapshot [-i]`. We may want to tune the compactness (depth, compact flag) for typical pages.

3. **Tab switching UX.** The user may want the agent to auto-detect the Grok tab or a named tab instead of requiring `tab:t2`.

4. **Error messages.** If `agent-browser` is truly missing, the current error is `Failed to start agent-browser: spawn ... ENOENT`. We may want a friendlier message pointing to installation.

5. **Skill discoverability.** The user provides the skill instructions manually before each browser task.

6. **Tests for the extension itself.** There are no unit tests under `tests/unit/` for `agent-browser` yet.

## What NOT to do

- Do NOT auto-inject skills into the system prompt. The user explicitly wants manual skill control.
- Do NOT add framework dependencies. One extension = one folder, minimal code.
- Do NOT enable/disable/copy extensions. The user handles that.
- Do NOT edit `~/.pi/agent/extensions/` or `~/.pi/agent/settings.json` unless explicitly asked.

## How to continue

1. Read this file.
2. Read the relevant skill files in `agent-browser/skills/`.
3. Read the tool source in `agent-browser/tools/`.
4. Run `npm run typecheck` and `python scripts/run-tests.py` after any code change.
5. For live browser tests, use the CLI commands shown above against `http://127.0.0.1:9222/` before testing inside Pi.
