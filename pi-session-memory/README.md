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
- **`/session-memory`** — interactive TUI menu for status, rebuild, search, and resume.

## Agent workflow

1. Ask the agent to recall something: "How did I set up OAuth last time?"
2. Agent calls `session_memory(action="search", query="OAuth2 FastAPI setup")`.
3. Agent sees 3 preview hits with scores.
4. Agent calls `session_memory(action="content", hitIndex=0, maxMessages=20)`.

## User workflow

- `/session-memory` — open the menu.
  - Status — check index health.
  - Rebuild index — trigger incremental rebuild.
  - Search sessions — type a query and see results.
  - Resume a session — pick current/all projects, choose a session, optionally add a note, and load context into the editor.

## Requirements

- 0x010 server running on `127.0.0.1:8000`
- `SESSION_INDEX_ENABLED=true` in `.env`
- Embedding server on port `8088`
