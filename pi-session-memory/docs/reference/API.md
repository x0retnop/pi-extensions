# pi-session-memory Backend Contract

> Client-side summary. The canonical spec lives in `0x010/docs/reference/SESSION_INDEX_SPEC.md`.

## Backend

- **Project:** `C:/10x001/AI comp/0x010`
- **Module:** `app/session_index/`
- **Base URL:** `http://127.0.0.1:8000`

## Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/session_index/status` | GET | Index health and stats |
| `/api/session_index/search` | POST | Semantic search over sessions |
| `/api/session_index/session_content` | POST | Read a specific session safely |
| `/api/session_index/rebuild` | POST | Trigger incremental rebuild |
| `/api/session_index/list` | POST | List saved sessions |

## Extension behavior

- `session_memory(action="last")` → returns the most recent session for the current project in one step (`list limit=1` + `content`).
- `session_memory(action="search")` → calls `/api/session_index/search`, stores results in session manager. Supports `scope` (`project`/`all`) and `cwd`.
- `session_memory(action="content")` → calls `/api/session_index/session_content`.
- `session_memory(action="list")` → calls `/api/session_index/list`. Supports `scope` (`project`/`all`) and `cwd`.
- `session_memory(action="find")` → calls `/api/session_index/search`, stores the top hit, then calls `/api/session_index/session_content` for the most relevant session. Supports `scope` and `cwd`.
- `/session-memory` → TUI menu that calls status / rebuild / search / find / list / session_content / export as needed.

## Configuration

Requires `SESSION_INDEX_ENABLED=true` in 0x010 `.env`.
