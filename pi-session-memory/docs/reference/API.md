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

- `search_sessions` → calls `/api/session_index/search`, stores results in session manager.
- `get_session_content` → calls `/api/session_index/session_content`.
- `/session-memory-status` → calls `/api/session_index/status`.
- `/session-memory-rebuild` → calls `/api/session_index/rebuild`.
- `/session-memory-resume` → calls `/api/session_index/list`, then `get_session_content`.

## Configuration

Requires `SESSION_INDEX_ENABLED=true` in 0x010 `.env`.
