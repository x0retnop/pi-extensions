# pi-session-memory

Semantic search over past Pi agent sessions via the 0x010 Session Vector Index.

## Install

```bash
pi install ./pi-session-memory
```

## Features

- **`session_memory`** — unified tool for the agent:
  - `action="search"` — semantic search across indexed `.jsonl` sessions.
  - `action="content"` — safely read a specific session with hard limits.
  - `action="list"` — list recent saved sessions for current or all projects.
  - `action="find"` — search and return the most relevant session content in one step.
- **`/session-memory`** — interactive TUI menu for status, rebuild, search, resume, and export.

## Agent workflow

1. Ask the agent to recall something: "How did I set up OAuth last time?"
2. Agent calls `session_memory(action="find", query="OAuth2 FastAPI setup")` to get the most relevant session content in one step.
3. Alternatively, agent calls `session_memory(action="search", query="OAuth2 FastAPI setup")` to compare hits, then `session_memory(action="content", hitIndex=0, maxMessages=20)`.

## User workflow

- `/session-memory` — open the menu.
  - Status — check index health.
  - Rebuild index — trigger incremental rebuild.
  - Search sessions — type a query and see results.
  - Resume a session — pick current/all projects, choose a session, optionally add a note, and load context into the editor.
  - Export session to Markdown — export a local `.jsonl` session to `chat`, `outline`, or `full` Markdown in the current `cwd`.

## Requirements

- 0x010 server running on `127.0.0.1:8000`
- `SESSION_INDEX_ENABLED=true` in `.env`
- Embedding server on port `8088`
