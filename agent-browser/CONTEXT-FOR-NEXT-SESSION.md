# Agent Browser — Context for the Next Session

This file is a condensed summary of what was learned from the previous test session (`testsss.md` and Pi session `019f03e7-2457-7b63-88d9-b468a9849b51`). Use it to continue without re-discovering the same issues.

## Chrome setup that works

- Chrome is started with:
  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\chrome-main" --remote-debugging-port=9222 --remote-allow-origins=*
  ```
- CDP endpoint: `http://127.0.0.1:9222/`
- The extension now hardcodes this as the default, so agents do not need to pass `cdp_url` every time.

## Extension behavior (current version)

- Default CDP is `http://127.0.0.1:9222/` — no need to pass `cdp_url` on every call.
- `browser action:open` works and returns `title` + `url`.
- Auto-wait `networkidle` runs after navigation and interaction actions.
- `browser action:text` reads visible page text (max 16 000 chars by default).
- `browser action:snapshot` returns the accessibility tree (max 300 lines / 30 000 chars by default).
- `browser_network action:requests` returns a summary by default; use `full:true` for headers.
- Outputs are truncated with `[TRUNCATED: ...]` when they exceed limits.
- Process kill timeout: if `agent-browser` CLI hangs, it is force-killed after 60s and resolved with a detailed error.

## Known issues with `agent-browser` CLI (not the extension)

1. **`browser_state action:state_load` and `cookies_set` hang / timeout**
   - The CLI process does not exit after `state load` or `cookies set`.
   - The extension now kills it after the timeout and returns a diagnostic message.
   - Workaround: after state load, verify by reading cookies with `browser_state action:cookies`.

2. **Initial `browser action:open` can timeout once**
   - First call after Chrome starts may return `Operation timed out. The page may still be loading or the element may not exist.`
   - Retry usually succeeds immediately.

3. **Slow first clicks/fills**
   - The first few interactions on a fresh page can take several seconds each.
   - Subsequent interactions are fast.

## Agent mistakes observed

1. **Stale refs on dynamic sites**
   - `snapshot` refs (`@eN`) are valid only for that snapshot.
   - After any DOM change (fill, click, SPA navigation, lazy load), refs become stale.
   - Agent must `snapshot` again before using refs.

2. **Multiple actions from one snapshot**
   - Agent tried to fill many fields and click several elements from a single snapshot.
   - Result: some fills/clicks failed because refs shifted.
   - Correct pattern: `snapshot → action → snapshot → action → ...`

3. **Submit without `text`**
   - `browser action:submit` requires both `selector` and `text`.
   - If `text` is missing, the tool returns an error.

4. **Clicking by text fallback failed on complex structures**
   - GitHub Issues tab: `"Issues 31"` did not match because text is split across nested elements.
   - HN story link: `"We All Depend on Open Source"` did not match because of nested `<a>` / `<td>` structure.
   - Solution: use URL navigation for tabs (`browser action:open url:...`) when possible.

5. **Not scrolling before click**
   - `agent-browser` does not auto-scroll to elements.
   - If an element is below the fold or covered by sticky header, click fails.
   - Use `browser action:eval text:"document.querySelector('...').scrollIntoView()"` before clicking.

## Site-specific notes

| Site | Notes |
|---|---|
| `example.com` | Static, reliable. Good sanity check. |
| `httpbingo.org/forms/post` | Form works. Timepicker fields can shift DOM. Text fields may come empty if navigation happens before submit. |
| `duckduckgo.com` | SPA-like. Search input ref changes after focus. Suggestion dropdown rerenders DOM. Easier to navigate by direct search URL. |
| `github.com/earendil-works` | Issues tab does not click reliably by text. Use direct URL `https://github.com/earendil-works/pi/issues`. |
| `news.ycombinator.com` | Works, but story link text may be split. Direct URL or `@eN` from fresh snapshot preferred. |
| `infinitescroll-six.vercel.app/` | Infinite scroll works with `eval` scroll. Content is repetitive placeholder text. |
| `bbc.com/weather/2643743` | Works. Large text output; cookie banner included. |
| `browserless.io/blog/state-of-ai-browser-automation-2026` | Readable article, returned ~16K text. |

## Recommended agent workflow

1. Start with `browser action:tabs` to see existing tabs.
2. Switch to a tab or `open` URL.
3. Take a `snapshot`.
4. Do ONE action using refs or a stable selector.
5. If the page might have changed, take another `snapshot` before the next action.
6. For SPA tabs, prefer direct URL navigation over clicking tabs.
7. For chat/LLM, use `wait_after:"<response marker>"` (e.g., `"Размышление"` for Grok) or poll `text`.
8. For large data, use `max_output_chars` or `full:true` explicitly.

## What the tools are for / not for

Use browser tools for:
- Real browser rendering and JS execution.
- User interactions: forms, clicks, chat inputs.
- Screenshots and visual checks.
- Cookies, storage, auth state.
- Network inspection for debugging.

Do NOT use browser tools for:
- General web search → `web_search`.
- Static article fetch → `fetch_content` / `curl` / `xh`.
- Direct file download → `curl` / `xh`.
- Quick HTTP testing → `curl` / `xh` / `httpbun.com` / `httpbingo.org`.

## Files the agent may reference

- Skill: `C:\tools\agent-browser\skills\core.md`
- Test plan: `C:\10x001\pi extensions\agent-browser\AGENT-TEST-PLAN.md`
- This context file: `C:\10x001\pi extensions\agent-browser\CONTEXT-FOR-NEXT-SESSION.md`

## Last successful test run summary

- 11/11 tasks completed successfully.
- ~44 browser interactions total.
- Main friction: stale refs on dynamic sites, state_load/cookies_set CLI hangs, slow first interactions.
- No context overflow occurred after output limits were added.
