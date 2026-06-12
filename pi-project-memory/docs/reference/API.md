# pi-project-memory Backend Contract

> Client-side summary. The canonical spec lives in `0x010/docs/reference/PROJECT_MEMORY_SPEC.md`.

## Backend

- **Project:** `C:/10x001/AI comp/0x010`
- **Module:** `app/project_memory/`
- **Base URL:** `http://127.0.0.1:8000`

## Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/project_memory/status` | GET | Registry of projects + counts |
| `/api/project_memory/search` | POST | Semantic search over facts and handoffs |
| `/api/project_memory/list` | POST | Recent records by date |
| `/api/project_memory/todos` | POST | List todos |
| `/api/project_memory/get` | POST | Full record detail |
| `/api/project_memory/add` | POST | Save a new record |
| `/api/project_memory/update` | POST | Update record status |
| `/api/project_memory/delete` | POST | Delete record + vector entry |

## Tools

- `project_memory_recent` → `/api/project_memory/list`
- `project_memory_search` → `/api/project_memory/search`
- `project_memory_get` → `/api/project_memory/get`
- `project_memory_add` → `/api/project_memory/add`
- `project_memory_list_todos` → `/api/project_memory/todos`

## Commands

- `/pm-status` → `GET /api/project_memory/status`
- `/pm-recent` → `/api/project_memory/list`
- `/pm-todos` → `/api/project_memory/todos`
- `/pm-search` → `/api/project_memory/search`
- `/pm-add` → `/api/project_memory/add`
- `/pm-handoff` → `/api/project_memory/add` (category `handoffs`, type `progress`)
- `/pm-get` → `/api/project_memory/get`
- `/pm-update` → `/api/project_memory/update`
- `/pm-delete` → `/api/project_memory/delete`

## Configuration

Requires `PROJECT_MEMORY_ENABLED=true` in 0x010 `.env`.
