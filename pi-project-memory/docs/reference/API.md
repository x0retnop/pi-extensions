# pi-project-memory Backend Contract

> Client-side summary. The canonical spec lives in `0x010/docs/reference/PROJECT_MEMORY_SPEC.md`.

## Backend

- **Project:** `C:/10x001/AI comp/0x010`
- **Module:** `app/project_memory/`
- **Base URL:** `http://127.0.0.1:8000` (override with `PI_PROJECT_MEMORY_URL` or `PI_BACKEND_URL` env var)

## Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/project_memory/status` | GET | Registry of projects + counts |
| `/api/project_memory/search` | POST | Semantic search over facts and handoffs |
| `/api/project_memory/list` | POST | Recent records by category and date |
| `/api/project_memory/list_all` | POST | Recent records across all categories |
| `/api/project_memory/todos` | POST | List todos |
| `/api/project_memory/get` | POST | Full record detail |
| `/api/project_memory/add` | POST | Save a new record |
| `/api/project_memory/update` | POST | Update record status |
| `/api/project_memory/update_full` | POST | Update editable fields of a record |
| `/api/project_memory/delete` | POST | Delete record + vector entry |

## Tools

- `project_memory_recent` → `/api/project_memory/list` (category `handoffs`)
- `project_memory_search` → `/api/project_memory/search`
- `project_memory_get` → `/api/project_memory/get`
- `project_memory_save` → `/api/project_memory/add` (category depends on `kind`: `fact`→`facts`, `handoff`→`handoffs`, `todo`→`todos`)
- `project_memory_list_todos` → `/api/project_memory/todos`

## Commands

- `/pm-status` → `GET /api/project_memory/status`
- `/pm-recent [N]` → `/api/project_memory/list`
- `/pm-todos [active|done|archived]` → `/api/project_memory/todos`
- `/pm-search <query>` → `/api/project_memory/search`
- `/pm-add-fact type|topic|what` → `/api/project_memory/add`
- `/pm-add-handoff topic|what` → `/api/project_memory/add`
- `/pm-add-todo topic|what` → `/api/project_memory/add`
- `/pm-add type|topic|what` → legacy alias (maps type to category)
- `/pm-handoff topic|what` → alias for `/pm-add-handoff`
- `/pm-get <item_id>` → `/api/project_memory/get`
- `/pm-update <item_id> <status>` → `/api/project_memory/update`
- `/pm-delete <item_id>` → `/api/project_memory/delete`
- `/pm` → interactive TUI dashboard

## Configuration

Requires `PROJECT_MEMORY_ENABLED=true` in 0x010 `.env`.

The extension reads its base URL from the environment, in order:

1. `PI_PROJECT_MEMORY_URL`
2. `PI_BACKEND_URL`
3. Fallback `http://127.0.0.1:8000`
