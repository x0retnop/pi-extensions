---
name: kimi-webbridge
description: >
  Control the user's real browser via Kimi WebBridge daemon.
  Navigate, click, fill, evaluate JS, screenshot, upload files, save PDF.
---

# Kimi WebBridge

## When to Use

Call this skill when you need to:
- Interact with websites using the user's real browser and login sessions
- Navigate, click, type, read page content, or take screenshots
- Scrape web content or automate browser tasks
- Upload files through a browser form or save a page as PDF

## Workflow

### Phase 0: Health Check
Always run first:
```bash
~/.kimi-webbridge/bin/kimi-webbridge status
```
Healthy when `running: true` and `extension_connected: true`.
If unhealthy, diagnose and fix before proceeding. See `./references/operations.md`.

### Phase 1: Prepare Session
1. Choose a session name to isolate browser tabs.
2. For a new site, call `navigate` with `newTab: true`.
3. To reuse an existing tab, call `find_tab` first. Fall back to `navigate` if not found.

### Phase 2: Interact
Send `curl` POST to `http://127.0.0.1:10086/command` with action and args.

### Phase 3: Cleanup
1. Call `close_session` at task end to close all tabs in the session.
2. Kill any spawned `http.server` processes.

## Conventions

- **MUST** run health check before any browser action.
- **MUST** pass `"session"` in every request body.
- **MUST** use `./scripts/screenshot.sh` for screenshots. **NEVER** call the `screenshot` action directly — base64 floods context.
- **MUST** prefer `@e` refs from `snapshot` for element targeting. Fallback to CSS selectors only if `@e` is absent.
- **MUST** use `evaluate` for complex events (scroll, hover, keyboard), hidden attributes (href), and when `@e` refs are missing.
- **MUST** serve local folders via `python -m http.server` — `file://` URLs are blocked by the extension.
- **NEVER** retry after "Please update the Kimi WebBridge extension" error. Tell the user to update and stop.
- **NEVER** attempt synthetic clicks on banking or captcha sites — `event.isTrusted` is a hard boundary.

## Core Actions

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"<ACTION>","args":{<ARGS>},"session":"<NAME>"}'
```

| Action | Args | Returns | Usage |
|--------|------|---------|-------|
| `navigate` | `url`, `newTab` (bool), `group_title` | `{success, url, tabId}` | Always `newTab:true` on first call. |
| `find_tab` | `url` (domain match), `active` (bool) | `{success, url, tabId}` | Reuse an open tab. Falls back to `navigate`. |
| `snapshot` | — | `{url, title, tree}` with `@e` refs | Read page content / locate elements. Prefer `@e` over CSS. |
| `click` | `selector` (@e or CSS) | `{success, tag, text}` | Synthetic click. |
| `fill` | `selector`, `value` | `{success, tag, mode}` | Replaces existing text on input/textarea/contenteditable. |
| `evaluate` | `code` (async/await OK) | `{type, value}` | Run JS. Use compact `JSON.stringify(data)`. Wrap in IIFE if re-declaring vars. |
| `screenshot` | `format`, `quality`, `selector` | `{format, dataLength, data}` (base64) | **Never call directly.** Use `./scripts/screenshot.sh`. |
| `upload` | `selector`, `files` (string[]) | `{success, fileCount}` | Upload files to a file input. |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `file_name` | `{path, sizeBytes, mimeType, pageTitle}` | Renders page to PDF under `/tmp/kimi-webbridge-pdfs/`. |
| `list_tabs` | — | `{tabs:[...]}` | Inspect open tabs. |
| `close_tab` | — | `{success, closed}` | Close current session tab. |
| `close_session` | — | `{success, closed: count}` | Close all tabs in session. **Call at task end.** |

### Screenshot helper

```bash
bash "./scripts/screenshot.sh"
bash "./scripts/screenshot.sh" -s my-task
bash "./scripts/screenshot.sh" -o /tmp/page.png -f jpeg -q 60
```

Returns the saved file path. On Windows the default output is under `/tmp/kimi-webbridge-screenshots/` (Git Bash temp).

### Fallback to `evaluate`

Use JS `evaluate` when:
- Target has no `@e` ref in snapshot
- You need attributes not in snapshot (e.g. `href`)
- Complex events (scroll, hover, dispatch keyboard events)

Example — press Escape:
```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"evaluate","args":{"code":"document.activeElement.dispatchEvent(new KeyboardEvent(\\"keydown\\",{key:\\"Escape\\",bubbles:true}))"}}'
```

## Local Files

`navigate` to `file://` URLs is blocked.

**Workaround:** serve the folder via Python HTTP server, then open `http://localhost:<port>/filename`.

```bash
cd /c/path/to/folder && python -m http.server 8765 &
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"http://localhost:8765/myfile.html","newTab":true},"session":"my-session"}'
```

Kill the server when done: `pkill -f "http.server 8765"`

## Known Limitations

- **Sites checking `event.isTrusted`** (banking, captcha) reject synthetic `click`/`fill` — hard boundary.
- **Cross-origin iframes**: tools operate on top frame only. Navigate to the iframe URL directly if needed.

## Example

**User action:** `/use-skill kimi-webbridge` + prompt: "Go to example.com, click the login button, screenshot the page."

**Agent behavior:**
1. Runs health check: `~/.kimi-webbridge/bin/kimi-webbridge status`.
2. Starts session "task-001".
3. Navigates to `http://example.com` with `newTab: true`.
4. Calls `snapshot` to get page tree and locate the login button via `@e` ref.
5. Calls `click` on the `@e` ref.
6. Calls `./scripts/screenshot.sh` to capture the page.
7. Returns the screenshot path and a brief page summary to the user.
8. Calls `close_session` to clean up.

## References

| Topic | When to use | File |
|-------|------------|------|
| Full diagnose steps | Health check fails, install issues, daemon troubleshooting | `./references/operations.md` |
| Screenshot helper | Any screenshot need | `./scripts/screenshot.sh` |
