# pi-session-memory

Semantic search over past Pi agent sessions via the 0x010 Session Vector Index.

## Install

```bash
pi install ./pi-session-memory
```

## Features

- `search_sessions` — semantic search across indexed `.jsonl` sessions. Returns preview excerpts with scores. Results are stored for the current session.
- `get_session_content` — safely read a specific session with hard limits (`maxMessages`, `maxChars`). Use `hitIndex` from the last `search_sessions` or an explicit `sourcePath`.
- `/session-memory-status` — show index status (enabled, indexed count, model).
- `/session-memory-rebuild` — trigger incremental rebuild.

## Workflow

1. Ask the agent to recall something: "How did I set up OAuth last time?"
2. Agent calls `search_sessions(query="OAuth2 FastAPI setup")`.
3. Agent sees 3 preview hits.
4. Agent calls `get_session_content(hitIndex=0, maxMessages=20)` to safely read the most relevant session.

## Requirements

- 0x010 server running on `127.0.0.1:8000`
- `SESSION_INDEX_ENABLED=true` in `.env`
- Embedding server on port 8088
