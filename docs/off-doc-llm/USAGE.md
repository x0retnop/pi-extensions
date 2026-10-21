# Usage

> Interactive mode, slash commands, editor features.

---

## Interactive mode layout

```
┌─ Startup header ──────────────────────────────┐
│ shortcuts, context files, skills, extensions   │
├─ Messages ────────────────────────────────────┤
│ user messages, assistant responses,            │
│ tool calls/results, notifications, errors, UI  │
├─ Editor ──────────────────────────────────────┤
│ type here; border color = thinking level       │
├─ Footer ──────────────────────────────────────┤
│ cwd, session name, tokens, cost, model         │
└────────────────────────────────────────────────┘
```

---

## Editor features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search |
| Path completion | Tab |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Copy response | Ctrl+X copies last assistant message |
| Paste image | Ctrl+V, Alt+V (Windows), or drag |
| Shell command | `!command` — runs and sends output to model |
| Hidden shell cmd | `!!command` — runs without sending output |
| External editor | Ctrl+G opens `$VISUAL` / `$EDITOR` |
| Queued message (steer) | Enter during streaming |
| Queued message (follow-up) | Alt+Enter during streaming |
| Abort + restore input | Escape during streaming |

---

## Slash commands

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery |
| `/resume` | Pick from previous sessions |
| `/new` | Start new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, tokens, cost) |
| `/tree` | Navigate session tree |
| `/trust` | Save project trust decision |
| `/fork` | New session from previous user message |
| `/clone` | Duplicate active branch into new session |
| `/compact [prompt]` | Manual compact with optional instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume JSONL session |
| `/share` | Upload as private GitHub gist |
| `/reload` | Reload extensions, skills, prompts, themes |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Version history |
| `/quit` | Quit |
| `/skill:name` | Load and execute a skill |
| `/template-name` | Expand prompt template |
| `//` | Repeat last message |

---

## CLI flags

| Flag | Description |
|------|-------------|
| `pi` | Start interactive |
| `-p`, `--print` | Print mode (single-turn, no TUI) |
| `-c`, `--continue` | Resume most recent session |
| `-r`, `--resume` | Browse and select session |
| `-n`, `--name <name>` | Session display name |
| `-e`, `--extension <path>` | Load extension (temporary) |
| `--fork <path\|id>` | Fork session into new |
| `--session <path\|id>` | Specific session file |
| `--no-session` | Ephemeral mode |
| `--no-skills` | Disable skill discovery |
| `--no-themes` | Disable theme discovery |
| `--no-prompts` | Disable prompt template discovery |
| `--provider <name>` | Set provider |
| `--model <pattern>` | Model ID or pattern |
| `--mode json` | JSON event stream mode |
| `--mode rpc` | RPC mode |
| `--mode print` | Same as `-p` |
| `--approve` / `-a` | Trust project for this run |
| `--no-approve` / `-na` | Skip trust for this run |
| `--list-models` | List available models |
| `--version` | Show version |
| `--help` | Help |

## Message queuing

| Action | Delivery | Behavior |
|--------|----------|----------|
| Enter (during streaming) | Steer | After current assistant turn finishes tool calls |
| Alt+Enter (during streaming) | Follow-up | After agent finishes all work |
| Escape | — | Abort + restore queued messages to editor |
| Alt+Up | — | Retrieve queued messages back to editor |
