# Settings

> JSON files: `~/.pi/agent/settings.json` (global) > `.pi/settings.json` (project).
> Edit directly or use `/settings`.

---

## Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | — | e.g. `"anthropic"`, `"openai"` |
| `defaultModel` | string | — | Model ID |
| `defaultThinkingLevel` | string | `"off"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show prompt-cache miss notices |
| `thinkingBudgets` | object | — | Custom token budgets per level |

`thinkingBudgets` example:
```json
{ "thinkingBudgets": { "minimal": 1024, "low": 4096, "medium": 10240, "high": 32768 } }
```

---

## UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | `"dark"`, `"light"`, or custom name |
| `externalEditor` | string | `$VISUAL` → `$EDITOR` → Notepad/nano | Command for Ctrl+G |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | `"ask"`, `"always"`, `"never"` |
| `collapseChangelog` | boolean | `false` | Condensed changelog |
| `enableInstallTelemetry` | boolean | `true` | Anonymous install ping |
| `enableAnalytics` | boolean | `false` | Opt-in analytics |
| `doubleEscapeAction` | string | `"tree"` | `"tree"`, `"fork"`, `"none"` |
| `treeFilterMode` | string | `"default"` | Default `/tree` filter |
| `editorPaddingX` | number | `0` | 0-3 |
| `outputPad` | number | `1` | 0 or 1 |
| `autocompleteMaxVisible` | number | `5` | 3-20 |
| `showHardwareCursor` | boolean | `false` | Hardware cursor for IME |

---

## Tool execution

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | — | Custom bash path (Windows) |
| `defaultTimeout` | number | `120000` | Default tool timeout (ms) |
| `bashTimeout` | number | `120000` | Bash timeout (ms) |
| `readMaxLines` | number | `2000` | Default max read lines |
| `readMaxBytes` | number | `51200` | Default max read bytes |

---

## Messaging

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"enter"` | How Enter behaves during streaming |
| `followUpMode` | string | `"alt-enter"` | How Alt+Enter behaves |

---

## Packages & Extensions

| Setting | Type | Description |
|---------|------|-------------|
| `packages` | string[] | Pi package sources (npm:, git:, URL, path) |
| `extensions` | string[] | Additional extension paths |
| `themes` | string[] | Additional theme paths |
| `skills` | string[] | Additional skill paths |
| `prompts` | string[] | Additional prompt template paths |
| `npmCommand` | string[] | npm wrapper command, e.g. `["mise", "exec", "node@20", "--", "npm"]` |

---

## Project trust

> Controls whether project-local `.pi/settings.json`, extensions, skills, etc. are loaded.
> Not a sandbox — does not restrict what the model can do.

- `defaultProjectTrust` in global settings: `"ask"` (default), `"always"`, `"never"`
- Use `/trust` to save decision
- Non-interactive modes: `--approve`/`-a` or `--no-approve`/`-na`

Trust is required for: `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, project `.agents/skills`.

---

## Full example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "high",
  "theme": "dark",
  "quietStartup": true,
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe",
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/custom-extension.ts"
  ],
  "thinkingBudgets": {
    "low": 2048,
    "medium": 8192,
    "high": 16384
  }
}
```
