# pi-session-memory

Semantic search over past Pi sessions via the 0x010 Session Vector Index.

## What it does

- Provides the `session_memory` tool for searching, listing, and reading previous sessions.
- Avoids reading huge `.jsonl` session files directly.

## Tool

- `session_memory`
  - `action: "search"` — semantic search across indexed sessions.
  - `action: "content"` — read a specific session with safe limits.
  - `action: "list"` — enumerate recent sessions.

## Important behaviors

- **Backend URL resolution**: `PI_SESSION_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.
- `action: "content"` uses safe defaults (`maxMessages=30`, `maxChars=4000`, `toolResultLimit=1000`).
- Last search results are stored as custom session entries so `hitIndex` can be used in the next call.
- Sessions are grouped by project using the `--...--` naming convention in session file paths.
- **Never use `read` on raw `.jsonl` session files** — they can be very large.

## Commands

- `/session-memory` — open the session memory menu (status, rebuild, search, resume).

## State

- 0x010 backend session index.
- Custom session entries with `customType: "session-memory-search"`.

## Source

- `pi-session-memory/index.ts`
