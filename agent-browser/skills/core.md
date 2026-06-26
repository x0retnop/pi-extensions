# Browser automation guide

Pi browser tools wrap the `agent-browser` CLI.

## Tool map

| Tool | Use for |
|---|---|
| `browser` | Open pages, snapshot, click/fill/type/submit, eval JS, read text, screenshot, close, wait. |
| `browser_network` | Mock/block requests, inspect traffic, record HAR. |
| `browser_state` | Cookies, storage, save/load auth state. |
| `browser_debug` | Console/errors, traces, React, vitals. |

## CDP URL

Pass `cdp_url` on the first browser call. It is remembered for the whole session and reused automatically.

```text
browser action:tabs cdp_url:"http://127.0.0.1:9222/"
browser action:tab tab:t2                           # cdp_url reused
browser action:snapshot                             # cdp_url reused
```

- Use `http://127.0.0.1:9222/`, not `ws://...`.
- Without `cdp_url` the tool launches its own bundled Chromium with a clean profile.
- Do not mix `cdp_url` with `headed:true`.

## Core loop

1. `browser action:open url:<url>` — load page or attach to running Chrome.
2. `browser action:snapshot` — compact accessibility tree with `@eN` refs.
3. Act using refs: `browser action:click selector:@e3`.
4. Re-snapshot after every navigation, click, or dynamic update.
5. `browser action:close` when done.

## Automatic waits

Navigation actions (`open`, `tab`, `back`, `forward`, `reload`) automatically wait for `networkidle` unless you set `wait_after:false`.

After `click`, `fill`, `type`, or `submit` you can add `wait_after:<target>` to avoid a separate wait call:

```text
browser action:click selector:@e3 wait_after:@e5
browser action:fill selector:@e4 text:hello wait_after:500
browser action:submit selector:@e4 text:hello wait_after:networkidle
```

`wait_after` accepts: `networkidle`, `domcontentloaded`, `load`, `@eN`/selector, `"some text"`, `"**/dashboard"`, `2000`.

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

By refs:

```text
browser action:click selector:@e1
browser action:fill selector:@e2 text:hello
browser action:type selector:@e2 text:" world"
```

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

```text
browser action:tabs
browser action:tab tab:t2
```

Tab ids look like `t1`, `t2`. Switch to the tab before taking a snapshot.

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

Use `session:<name>` to isolate parallel workflows. Each session is an independent browser. Always close sessions to free resources.

## Common problems

- **"Ref not found" / "Element not found"**: the page changed since the snapshot. Re-snapshot. The tool also auto-falls back to the element's aria-label/text for `@eN` selectors.
- **Element exists but not in the snapshot**: it is off-screen or not yet rendered. Scroll or wait, then re-snapshot.
- **Click fails / "covered by ..."**: a modal/banner is blocking. Interact with the covering element first, or dismiss it, then re-snapshot.
- **Fill/type doesn't work**: the input may need `focus` first or raw keystrokes via `eval`/`type`.
- **submit can't find the button**: use the manual fill → snapshot → click pattern.
- **Need complex JS**: use `eval`.
- **Auth**: log in once, then `browser_state action:state_save path:./auth.json`, load next time with `state_load`.
