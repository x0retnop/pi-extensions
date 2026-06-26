# Browser automation guide

Use **only** the Pi browser tools listed below. Do not run `agent-browser` directly from bash and do not open a new browser process.

Connect to the user's already-running Chrome with `cdp_url:"http://127.0.0.1:9222/"` and work with the existing tabs. Do not close the user's browser.

## What these tools are for

Use browser tools when the task requires a real browser: rendering, JavaScript, user interaction, session state, screenshots, or network inspection.

Examples:
- Filling forms, clicking buttons, chatting in a web UI.
- Taking screenshots to check layout or visual state.
- Inspecting network requests for debugging ads, trackers, or scripts.
- Reading React/component trees or console errors.
- Working with sites that need cookies, localStorage, or logged-in state.

## What these tools are NOT for

Do not use browser tools when a simpler tool can do the job. They are heavier and can return large outputs.

| Instead of browser tools | Use |
|---|---|
| Searching the web or finding current information | `web_search` / `pi-web-search` |
| Fetching a static article or API response | `fetch_content`, `curl`, `xh`, or direct HTTP requests |
| Downloading a file from a direct URL | `curl`, `xh`, or `bash` |
| Quick HTTP/API testing | `curl`, `xh`, `httpbun.com`, `httpbingo.org` |
| Reading local files | `read` |

**Never** call the `agent-browser` CLI directly from bash. Always use the Pi browser tools above.

## CDP URL

The tools connect to the user's already-running Chrome at `http://127.0.0.1:9222/` by default. You can pass `cdp_url` only if you need a different Chrome instance.

```text
browser action:tabs                                 # default CDP used
browser action:tab tab:t2                           # default CDP reused
browser action:snapshot                             # default CDP reused
```

- Use `http://127.0.0.1:9222/`, not `ws://...`.
- Without CDP the tool would launch its own bundled Chromium with a clean profile — avoid that unless you explicitly need an isolated session.
- Do not mix `cdp_url` with `headed:true`.

## Core loop

1. Pass `cdp_url:"http://127.0.0.1:9222/"` on the very first browser call to attach to the user's Chrome.
2. `browser action:tabs` — find the tab you need, or use `browser action:tab tab:<id>` to switch to it.
3. `browser action:snapshot` — compact accessibility tree with `@eN` refs.
4. Act using refs: `browser action:click selector:@e3`.
5. Re-snapshot after every navigation, click, or dynamic update.

Do not call `browser action:close` unless you created an isolated `session:<name>` and want to clean it up. In CDP mode `close` can kill the user's browser tab or process.

## Automatic waits

Navigation actions (`open`, `tab`, `back`, `forward`, `reload`) automatically wait for `networkidle` unless you set `wait_after:false`.

`click`, `fill`, `type`, and `submit` also auto-wait for `networkidle` after the action. This waits for the action itself to settle (e.g. the request to finish sending), not for a brand-new chat/LLM response to fully appear.

For chat and LLM interfaces, use `wait_after` with a response marker so the tool waits until the model starts answering:

```text
browser action:submit selector:"[aria-label=\"Ask Grok anything\"]" text:"hello" wait_after:"Размышление"
```

If you do not know a reliable marker, poll with `browser action:text`:

```text
browser action:submit selector:@e4 text:hello wait_after:false
browser action:wait wait:3000
browser action:text
```

`wait_after` accepts: `networkidle`, `domcontentloaded`, `load`, `@eN`/selector, `"some text"`, `"**/dashboard"`, `2000`, or `false` to skip the default wait.

## Output limits

Browser tools can return large data. To protect context, outputs are truncated by default:

- `browser action:snapshot` — max 300 lines / 30 000 chars.
- `browser action:text` — max 16 000 chars (use `max_output_chars` for more).
- `browser action:eval` — max 30 000 chars.
- `browser_network action:requests` — summary only (method, URL, status, resourceType). Max 50 entries without `pattern`, 200 with `pattern`. Use `full:true` for headers.
- `browser_state` and `browser_debug` — max 30 000 chars.

If output is truncated, the response includes a hint like `[TRUNCATED: ...]`. Use `max_output_chars:<n>` or `full:true` to see more.

## Reading page text

Use `browser action:text` to read the visible text of the active page. No selector guessing needed:

```text
browser action:text
```

For a specific region, use `eval`:

```text
browser action:eval text:"document.querySelector('main').innerText.slice(0, 4000)"
```

## Interacting

By `@eN` refs:

```text
browser action:click selector:@e1
browser action:fill selector:@e2 text:hello
browser action:type selector:@e2 text:" world"
```

The literal `[ref=eN]` text shown in snapshots is also accepted, but prefer `@eN`.

By CSS selector or label:

```text
browser action:click selector:"#submit"
browser action:fill selector:"[aria-label=\"Ask Grok anything\"]" text:hello
browser action:click selector:"button[aria-label=\"Отправить\"]"
```

`@eN` refs automatically fall back to the element's `aria-label` or visible text if the ref becomes stale between snapshot and action.

## Forms and chat inputs

`submit` fills the input and clicks the nearest send/submit button in one call:

```text
browser action:submit selector:"[aria-label=\"Ask Grok anything\"]" text:"hello" wait_after:networkidle
```

If `submit` cannot find the button, fall back to manual:

```text
browser action:fill selector:"[aria-label=\"Ask Grok anything\"]" text:"hello" wait_after:500
browser action:snapshot
browser action:click selector:"button[aria-label=\"Отправить\"]" wait_after:networkidle
```

## Snapshot options

The `snapshot` action supports these `extra_args`:

```text
browser action:snapshot extra_args:["-i"]                     # interactive elements only (default)
browser action:snapshot extra_args:["-i","-u"]                # include link hrefs
browser action:snapshot extra_args:["-i","-c"]                # compact
browser action:snapshot extra_args:["-i","-d","3"]            # cap depth at 3 levels
browser action:snapshot extra_args:["-s","#main"]             # scope to a CSS selector
browser action:snapshot extra_args:["--json"]                 # machine-readable output
```

## Tabs

Always inspect the user's existing tabs first. Do not open a new browser.

```text
browser action:tabs
browser action:tab tab:t2
```

Tab ids look like `t1`, `t2`. Switch to the tab before taking a snapshot.

To open a URL in a new tab in the user's Chrome:

```text
browser action:open url:"https://example.com" extra_args:["--new-tab"]
```

To open a URL in the current tab:

```text
browser action:open url:"https://example.com"
```

## Waits

Use `wait_after` on the action, or call `browser action:wait` separately:

```text
browser action:wait wait:networkidle
browser action:wait wait:@e5
browser action:wait wait:"Order placed"
browser action:wait wait:"**/dashboard"
browser action:wait wait:2000
```

Avoid bare millisecond waits unless absolutely necessary.

## Keyboard input

Some custom inputs intercept key events and `fill` is not enough. Use `type` or raw keyboard via `eval`:

```text
browser action:type selector:@e1 text:hello
browser action:eval text:"document.querySelector('input').focus(); document.execCommand('insertText', false, 'hello')"
```

## Iframes

Iframes are usually auto-inlined in the snapshot; their refs work transparently. If not, scope via `eval`:

```text
browser action:eval text:"Array.from(document.querySelectorAll('iframe')).map(f => f.src)"
browser action:eval text:"document.querySelector('iframe#payment').contentDocument.querySelector('input').value"
```

## Dialogs

`alert` and `beforeunload` are auto-accepted. `confirm`/`prompt` are not directly supported — dismiss them via `eval` if one blocks the flow.

## Sessions

Use `session:<name>` to isolate parallel workflows. Each session is an independent browser. Always close sessions you created to free resources.

When no `session` is given, the tool uses the user's live Chrome via CDP. In that case do **not** call `close`.

## Common problems

- **"Ref not found" / "Element not found"**: the page changed since the snapshot. Re-snapshot. The tool also auto-falls back to the element's aria-label/text for `@eN` selectors.
- **Element exists but not in the snapshot**: it is off-screen or not yet rendered. Scroll or wait, then re-snapshot.
- **Click fails / "covered by ..."**: a modal/banner is blocking. Interact with the covering element first, or dismiss it, then re-snapshot.
- **Fill/type doesn't work**: the input may need `focus` first or raw keystrokes via `eval`/`type`.
- **submit can't find the button**: use the manual fill → snapshot → click pattern.
- **Need complex JS**: use `eval`.
- **Auth**: log in once, then `browser_state action:state_save path:./auth.json`, load next time with `state_load`.
