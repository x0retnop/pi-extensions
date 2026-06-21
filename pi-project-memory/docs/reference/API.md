# pi-project-memory Backend Contract

> Client-side summary. The canonical spec lives in `0x010/docs/reference/PROJECT_MEMORY_SPEC.md`.

## Backend

- **Project:** `C:/10x001/AI comp/0x010`
- **Module:** `0x010/app/project_memory/`
- **Base URL:** `http://127.0.0.1:8000` (override with `PI_PROJECT_MEMORY_URL` or `PI_BACKEND_URL` env var)
- **Prompts:** `0x010/app/project_memory/prompts/`

## Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/project_memory/status` | GET | Registry of projects + counts (TUI dashboard only) |
| `/api/project_memory/search` | POST | Semantic search over facts |
| `/api/project_memory/list` | POST | Recent records by category and date |
| `/api/project_memory/list_all` | POST | Recent records across all categories |
| `/api/project_memory/todos` | POST | List todos |
| `/api/project_memory/get` | POST | Full record detail (used by TUI) |
| `/api/project_memory/add` | POST | Save a new record |
| `/api/project_memory/update` | POST | Update record status (handoffs only) |
| `/api/project_memory/update_full` | POST | Update editable fields of a record |
| `/api/project_memory/delete` | POST | Delete record + vector entry |
| `/api/project_memory/merge` | POST | Merge source into target and delete source |
| `/api/project_memory/review_queue` | POST | Oldest-first facts for agent review |
| `/api/project_memory/extract` | POST | Extract durable facts from a session transcript |

## Agent tools

- `project_facts({ query?, recent?, limit? })` → search or list recent facts. Returns full records (truncated only if the total result would exceed context limits).
- `curate_facts({ action: "list" | "update" | "merge" | "delete", ... })` → manually-enabled fact curation.

## Commands

- `/pm` → interactive TUI dashboard
- `/remember type|topic|what` → `/api/project_memory/add`
- `/todo topic|what` → `/api/project_memory/add`
- `/done` → builds session transcript, calls `/api/project_memory/extract`, then `/api/project_memory/add` for selected facts

## Add endpoint

`POST /api/project_memory/add`

Saves a new record, or returns an existing duplicate if the candidate is too similar to a record already stored.

Body: see canonical spec.

Response when a new record is saved:
```json
{
  "ok": true,
  "item_id": "pm-abc123"
}
```

Response when a duplicate is detected:
```json
{
  "ok": true,
  "item_id": "pm-abc123",
  "duplicate": true,
  "score": 0.94,
  "method": "embedding"
}
```

When `duplicate` is `true`, `item_id` refers to the existing record and no new record is created. `method` is one of `exact`, `jaccard`, or `embedding`.

## Merge endpoint

`POST /api/project_memory/merge`

Merges a source fact into a target fact and deletes the source. The target keeps the union of `where`/`tags`, plus a `merged:<source_id>` tag.

```json
{
  "project_id": "my-app",
  "source_item_id": "pm-old",
  "target_item_id": "pm-new",
  "fields": {
    "topic": "Merged topic (optional)",
    "what": "Merged description (optional)",
    "why": "...",
    "where": ["file.ts"],
    "tags": ["api"]
  }
}
```

## Extract endpoint

`POST /api/project_memory/extract`

Body:
```json
{
  "project_id": "my-app",
  "transcript": "## user\n...\n\n## assistant\n..."
}
```

Response:
```json
{
  "ok": true,
  "facts": [
    {"fact_type": "decision", "topic": "...", "what": "..."}
  ]
}
```

The prompt used for extraction lives in `app/project_memory/prompts/extract_facts.md` and can be edited without restarting the backend (it is read on each call).

## Configuration

Requires `PROJECT_MEMORY_ENABLED=true` in 0x010 `.env`.

The extension reads its base URL from the environment, in order:

1. `PI_PROJECT_MEMORY_URL`
2. `PI_BACKEND_URL`
3. Fallback `http://127.0.0.1:8000`
