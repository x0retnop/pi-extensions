# pi-session-memory

Semantic search over past Pi sessions via the 0x010 Session Vector Index.

## What it does

- Provides the `session_memory` tool for searching, listing, and reading previous sessions.
- Avoids reading huge `.jsonl` session files directly.
- Useful when continuing from a handoff file that refers to details kept in the session history.

## Tool

- `session_memory`
  - `action: "search"` — semantic search across indexed sessions. Good for finding exact error messages, prior debugging steps, or decisions mentioned in a handoff file.
  - `action: "content"` — read a specific session with safe limits.
  - `action: "list"` — enumerate recent sessions.
  - `action: "find"` — search and return the most relevant session content in one step. Prefer this when a handoff file points to details kept in session history.

## Important behaviors

- **Backend URL resolution**: `PI_SESSION_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.
- `action: "content"` uses safe defaults (`maxMessages=30`, `maxChars=4000`, `toolResultLimit=1000`).
- Last search results are stored as custom session entries so `hitIndex` can be used in the next call.
- Sessions are grouped by project using the `--...--` naming convention in session file paths.
- **Never use `read` on raw `.jsonl` session files** — they can be very large.

## Commands

- `/session-memory` — open the session memory menu (status, rebuild, search, find, resume, export).

## Local export

The TUI menu includes **Export session to Markdown** that works without the 0x010 backend:

1. Scans `~/.pi/agent/sessions/**/*.jsonl`.
2. Lets you pick a session.
3. Lets you pick a format:
   - `chat` — only user/assistant text.
   - `outline` — user/assistant text plus a short action summary (tools used, bash heredocs, etc.).
   - `full` — everything: texts, tool calls with arguments, tool results, thinking blocks, bash output.
4. Writes `<date>_<session-title>.<format>.md` to the current Pi `cwd`, where the title is derived from the first user message in the session.

Limits: session files larger than 256 MB are skipped; output is capped at 500 000 chars.

## State

- 0x010 backend session index (for search/list/content).
- Custom session entries with `customType: "session-memory-search"`.

## Continuation tip

When a `handoff-*.md` file says a specific detail is "in the previous session" or "in the session history", the next agent should call `session_memory(action="find", query="...")` to retrieve that detail in one step, or use `action="search"` to compare multiple candidates first.

## Source

- `pi-session-memory/index.ts`
