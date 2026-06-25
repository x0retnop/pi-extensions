# Web automation

Core `browser` tool actions.

## Quickstart

```text
browser action:open url:https://example.com
browser action:snapshot interactive:true
browser action:click selector:@e2
browser action:snapshot interactive:true
browser action:close
```

## Actions

- `open url:<url>` — navigate to URL.
- `snapshot` — accessibility tree. Use `interactive:true` for only interactive elements.
- `click selector:<@eN|css>` — click element.
- `fill selector:<@eN|css> text:<value>` — clear and type.
- `type selector:<@eN|css> text:<value>` — type without clearing.
- `eval text:<js>` — run JS in the page. Prefer for multi-line scripts.
- `screenshot screenshot_path:<path>` — save screenshot.
- `close` — close session.
- `back`, `forward`, `reload` — navigation.
- `wait wait:<target>` — wait for selector, text, URL glob, networkidle, or ms.

## Refs

`snapshot` returns `@e1`, `@e2`, ... refs. They become stale after any page change. Always re-snapshot before using refs again.

## Tips

- Use `interactive:true` to keep snapshots small.
- Prefer `@eN` refs over CSS selectors.
- After navigation, use `wait` before snapshotting.
- Pass `headed:true` to see the browser window.
- Pass `extra_args:["--auto-connect"]` to reuse your logged-in Chrome.
