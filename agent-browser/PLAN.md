# agent-browser Pi extension — Implementation Plan

## Goal
Wrap the `agent-browser` CLI as a set of Pi tools with an on/off TUI gate.
All browser tools are **inactive by default**. The user enables them via `/browser`.
`browser-help` is only active when at least one browser tool is enabled.
Skills are stored inside the extension and trimmed from the upstream `agent-browser` skill files.

## Files to create

```
agent-browser/
  index.ts              # command /browser, TUI, tool registration, active-tool sync
  config.ts             # load/save ~/.pi/agent/agent-browser.json
  types.ts              # AgentBrowserConfig, ToolToggleKey
  package.json          # extension manifest
  README.md             # user doc
  ui/
    main-screen.ts      # checkbox list of tools with descriptions
  tools/
    browser.ts          # core automation tool
    network.ts          # network interception tool
    state.ts            # cookies/storage/auth tool
    debug.ts            # CDP/console/trace/react/vitals tool
    help.ts             # skill map loader
  skills/
    map.md              # tool map + when to use each
    web-automation.md   # open/snapshot/click/fill/type/eval/screenshot
    network.md          # route/mock/HAR/requests
    state.md            # cookies/storage/auth/profiles
    debug.md            # CDP/console/errors/trace/react/vitals
docs/extensions/agent-browser.md  # project extension doc
```

## Extension behavior

### Activation model
- Register all tool definitions on `session_start` and `session_tree` so they exist in `pi.getAllTools()`.
- Call `pi.setActiveTools()` to expose only enabled tools to the LLM.
- If no browser tool is enabled, `browser-help` is also inactive.
- Persist enabled flags in `~/.pi/agent/agent-browser.json`.

### TUI command `/browser`
- Open a small TUI with a checkbox list.
- Items:
  - `browser` — core automation
  - `browser-network` — network mocking
  - `browser-state` — cookies/storage/auth
  - `browser-debug` — CDP/console/trace/react
- Hints per item explain what it does.
- Footer: `Space toggle • q save & quit`
- On save: update config, sync active tools, show `ctx.ui.notify`.

### Tool naming & schema

All tools receive JSON parameters, translate them to `agent-browser ... --json` CLI calls, parse JSON output, and return compact text.

#### `browser`
Actions: `open`, `navigate`, `snapshot`, `click`, `fill`, `type`, `eval`, `screenshot`, `close`, `back`, `forward`, `reload`, `wait`.
Parameters:
- `action` (string, enum, required)
- `url` (string, for open/navigate)
- `selector` (string, for click/fill/type, supports `@eN` refs)
- `text` (string, for fill/type/eval)
- `interactive` (boolean, snapshot -i, default true)
- `headed` (boolean)
- `session` (string)
- `screenshotPath` (string)
- `wait` (string: ms, selector, text, url, networkidle, or JS expression)
- `extraArgs` (string[], escape hatch)

Prompt guidelines:
1. Start with `open` or `snapshot`.
2. Use `snapshot -i` to discover `@eN` refs.
3. After any navigation/click, refs become stale — snapshot again.
4. Prefer refs over CSS selectors.
5. Always `close` when done to free the session.

#### `browser-network`
Actions: `route`, `unroute`, `requests`, `request`, `har_start`, `har_stop`.
Parameters:
- `action` (enum)
- `pattern` (string, glob/URL)
- `abort` (boolean)
- `body` (string, JSON)
- `resourceType` (string)
- `requestId` (string)
- `outputPath` (string, for HAR)
- `session` (string)
- `extraArgs` (string[])

#### `browser-state`
Actions: `cookies`, `cookies_set`, `cookies_clear`, `storage_local`, `storage_session`, `state_save`, `state_load`.
Parameters:
- `action` (enum)
- `name`, `value`, `domain` (cookies)
- `key` (storage)
- `path` (state save/load)
- `session` (string)
- `extraArgs` (string[])

#### `browser-debug`
Actions: `cdp_url`, `console`, `errors`, `trace_start`, `trace_stop`, `react_tree`, `react_inspect`, `vitals`, `eval`.
Parameters:
- `action` (enum)
- `expression` (string, eval)
- `fiberId` (string, react_inspect)
- `outputPath` (string, trace)
- `session` (string)
- `extraArgs` (string[])

#### `browser-help`
Parameters:
- `topic` (enum: `map`, `web-automation`, `network`, `state`, `debug`, default `map`)
- `full` (boolean, reserved; for now ignored)

Behavior: read the matching markdown file from `agent-browser/skills/` and return its text.

## Shared helpers to put in `index.ts` or a new `utils.ts`

- `runAgentBrowser(args: string[], session?: string, timeout?: number): Promise<{ ok: boolean; output: string; error?: string }>`
  - Spawn `agent-browser` with `--json`.
  - Inject `--session` if provided.
  - Merge `stdout`/`stderr`, parse JSON, extract `data` or `error`.
- `parseWaitOption(wait: string): string[]` — translate `wait` value to CLI flags.
- `sanitizeSelector(sel: string): string` — ensure `@eN` and CSS selectors are passed safely.

## Skill editing guidelines

Take `agent-browser` upstream files:
- `skill-data/core/SKILL.md`
- `skill-data/core/references/commands.md`
- `skills/agent-browser/SKILL.md`

Remove:
- Installation/update/upgrade instructions
- Build from source / Docker / Homebrew / Cargo info
- MCP server integration section
- Linux-only `--with-deps`
- Large troubleshooting stories (keep short bullets)
- Environment variables that are rarely needed

Keep:
- Core loop snapshot → action → re-snapshot
- Commands relevant to each tool
- Short examples
- Critical warnings (refs stale after navigation, click covered by banner, etc.)

Target size per skill:
- `map.md` — ~1 KB
- `web-automation.md` — ~3 KB
- `network.md` — ~2.5 KB
- `state.md` — ~2 KB
- `debug.md` — ~2.5 KB

## Implementation order

1. Create folder structure and `package.json`.
2. Write `types.ts` and `config.ts`.
3. Write `tools/help.ts` (simplest; reads skills).
4. Write `tools/browser.ts` (most important).
5. Write `tools/network.ts`, `tools/state.ts`, `tools/debug.ts`.
6. Write `ui/main-screen.ts`.
7. Write `index.ts` wiring everything together.
8. Trim skills from upstream into `skills/`.
9. Write `README.md` and `docs/extensions/agent-browser.md`.
10. Run `npm run typecheck` from repo root.
11. Test smoke flow:
    - `/browser` enable `browser` only
    - `browser action:open url:https://example.com`
    - `browser action:snapshot interactive:true`
    - `browser action:click selector:@e2`
    - `browser action:close`
    - `/browser` disable `browser` and verify `browser-help` also disappears from active tools.

## Notes

- Use `pi.setActiveTools()` on `session_start` / `session_tree` and after TUI save.
- Be careful with load order: other extensions may also call `pi.setActiveTools()`. Preserve existing active tools and only add/remove browser tool names.
- Do not use `pi.unregisterTool()`; deactivation via `setActiveTools` is sufficient.
- All CLI calls must include `--json` for parsing.
- Keep tool descriptions concise (under ~1 KB each) to avoid bloating the prompt.
