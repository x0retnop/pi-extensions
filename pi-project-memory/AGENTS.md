# pi-project-memory — Agent Context

## What this is

Cross-session project memory for Pi agents. Replaces long handoff files between sessions with searchable "fact cards". 0x010 backend provides vector storage (sqlite-vec) + JSONL persistence; Pi extension provides tools and commands.

**No auto-extraction.** Only explicit save via agent tool call or user command. This keeps control in user's hands and avoids pollution from rewinded sessions.

## Architecture

```
Pi Extension (TypeScript)          0x010 Backend (Python)
├── tools: recent, search, get,    ├── app/project_memory/
│          add, list_todos         │   ├── models.py    (Record dataclass)
├── commands: /pm-*                │   ├── store.py     (JSONL per project)
└── resolve .project-id in cwd     │   ├── indexer.py   (sqlite-vec ns="project_memory")
                                   │   └── service.py   (business logic)
                                   └── web_app.py      (8 REST endpoints)
```

## Project Identity

Create `.project-id` in cwd (one line, e.g. `pi-extensions`).
- Extension reads it on every tool call. Fallback: `basename(cwd)_fallback`.
- 0x010 stores data in `data/project_memory/<project_id>/{facts,handoffs,todos}.jsonl`.
- Commit `.project-id` to git — memory follows the project through renames/moves.

## Record Format (JSONL + vector index)

```json
{
  "item_id": "pm-abc123",
  "project_id": "pi-extensions",
  "category": "facts|handoffs|todos",
  "type": "decision|pattern|gotcha|architecture|progress|todo_item|bugfix",
  "topic": "Runtime dep install path",
  "what": "Deps installed in shared ~/.pi/agent, never inside extension folder",
  "why": "Pi core packages are peerDeps; bundling causes version conflicts",
  "where": ["docs/creating-extensions.md"],
  "tags": ["dependencies", "workflow"],
  "status": "active",
  "created_at": "2026-06-11T..."
}
```

**Categories:**
- `facts` — eternal decisions, patterns, architecture, gotchas. Indexed in vector DB.
- `handoffs` — short session summaries ("Session X: did Y. Stopped at Z. Next: W"). Rotated to last 30 entries. Indexed in vector DB.
- `todos` — open tasks between sessions. NOT indexed in vector DB (JSONL only).

## 0x010 API Endpoints

Base: `http://127.0.0.1:8000`

| Method | Endpoint | Body | Description |
|---|---|---|---|
| GET | `/api/project_memory/status` | — | Registry of projects + counts |
| POST | `/api/project_memory/search` | `{query, project_id?, category?, limit?}` | Semantic search (vector) |
| POST | `/api/project_memory/list` | `{project_id, category="handoffs", limit?}` | Recent records by date |
| POST | `/api/project_memory/todos` | `{project_id, status="active", limit?}` | List todos |
| POST | `/api/project_memory/get` | `{project_id, item_id}` | Full record detail |
| POST | `/api/project_memory/add` | `{project_id, category, type, topic, what, ...}` | Save new record |
| POST | `/api/project_memory/update` | `{project_id, item_id, status}` | Update status (e.g. todo→done) |
| POST | `/api/project_memory/delete` | `{project_id, item_id}` | Delete record + vector entry |

All endpoints are wrapped in `run_in_threadpool` (no blocking I/O in async loop).

## Pi Extension Tools

| Tool | When to call | Params |
|---|---|---|
| `project_memory_recent` | Start of session, "continue", "where did we stop", "что делали" | `limit?: 1-10` |
| `project_memory_search` | "How do we do X?", "where is Y described?", before reading 3+ files | `query, category?, limit?` |
| `project_memory_get` | Follow-up to search/recent for full detail | `item_id` |
| `project_memory_add` | After decision/gotcha/refactor, or user says "remember"/"запомни" | `type, topic, what, why?, where?, tags?` |
| `project_memory_list_todos` | "What else to do?", "show todos", "что осталось" | `status?, limit?` |

**PromptGuidelines** (enforced in index.ts):
- `recent`: call at session start or when user says continue/catch-up.
- `search`: use specific technical terms; "TypeBox validation" > "validation".
- `add`: keep topic <6 words, what as one concrete sentence, include `where` for file paths.

## Pi Extension Commands (user-facing)

| Command | Args | Description |
|---|---|---|
| `/pm-status` | — | Show project counts |
| `/pm-recent [N]` | N=5 default | Last N handoffs |
| `/pm-todos [active\|done]` | status=active | List todos |
| `/pm-search <query>` | query required | Manual semantic search |
| `/pm-add type|topic|what` | all required | Save a fact or todo manually |
| `/pm-handoff topic|what` | all required | Save a session handoff |
| `/pm-get <item_id>` | item_id required | Read full record detail |
| `/pm-update <item_id> <status>` | both required | Update record status |
| `/pm-delete <item_id>` | item_id required | Delete a record |
| `/pm-add type|topic|what` | all required | Save a fact or todo manually |

## Config in 0x010

Add to `.env`:
```
PROJECT_MEMORY_ENABLED=true
PROJECT_MEMORY_DIR=data/project_memory
PROJECT_MEMORY_DB_PATH=data/project_memory.sqlite3
```

Fields wired into `AppConfig`: `project_memory_enabled`, `project_memory_dir`, `project_memory_db_path`.

## What was done in this session

1. Designed architecture: 3 categories (facts/handoffs/todos), explicit-only save, `.project-id` for stable project binding.
2. Created 0x010 backend module `app/project_memory/`:
   - `models.py` — `ProjectMemoryRecord` dataclass
   - `store.py` — JSONL per project, handoff rotation to 30 entries
   - `indexer.py` — sqlite-vec namespace `project_memory`, todos skipped
   - `service.py` — CRUD + search
3. Added 8 REST endpoints to `app/web_app.py` with `run_in_threadpool`.
4. Wired `ProjectMemoryService` into `ChatService.from_config()`.
5. Added env parsing + validation to `app/config.py`.
6. Created Pi extension `pi-project-memory/`:
   - `index.ts` — 5 tools + 4 commands
   - `package.json` + `README.md`

## Audit fixes applied (from CORE_REGISTRY.md review)

1. **Blocking I/O** — all endpoints wrapped in `run_in_threadpool`.
2. **Orphan vectors on rotation** — `_rotate_handoffs()` returns dropped `item_id`s; `service.add()` deletes them from vector DB.
3. **Missing env config** — `PROJECT_MEMORY_*` vars parsed in `AppConfig.load()`, validated, exposed in `to_safe_dict()` and `update_safe_field()`.
4. **Empty project_id guard** — `service.add()` rejects empty `project_id` before creating record.
5. **ValueError guard** — `_safe_limit()` helper protects `int(body.get("limit"))`.

## Runtime verification & fixes (this session, 2026-06-11)

1. **Enabled project memory in 0x010** — added `PROJECT_MEMORY_ENABLED=true` + paths to `.env` and restarted runtime via `server_CFG` agent API.
2. **Verified all 8 REST endpoints** with direct curl calls: status, add (facts/handoffs/todos), list, todos, get, update, delete, search.
3. **Verified handoff rotation + orphan cleanup** — 32 handoffs collapse to 30 JSONL lines and dropped records disappear from vector search.
4. **Verified todos are not vector-indexed** — search over todos returns empty hits as designed.
5. **Fixed extension `/pm-status`** — it was calling `apiPost` on a GET endpoint; added `apiGet` helper and switched status to GET.
6. **Added `/pm-add` command** to extension — manual save with syntax `type|topic|what`.
7. **Hardened JSONL parsing** — `update_record_status()` and `delete_record()` now skip blank/corrupted lines instead of crashing.
8. **Fixed `_safe_limit(0, …)`** — zero and negative limits now fall back to default instead of clamping to `min_val`.

## Known limitations / future work

- **No auto-extract from sessions.** User must call `project_memory_add` or `/pm-add` manually. This is intentional for control.
- **No tests yet.** `tests/test_project_memory.py` needed: store CRUD, indexer upsert/search/delete, service add/update/delete/status, handoff rotation + orphan cleanup.
- **`/pm-add` is basic.** It only supports `type|topic|what`. No `why`, `where`, or `tags` from the command line; use the tool for richer records.
- **No `/pm-capture` summarize command.** v2 idea: feed last N messages to LLM, get suggested topic/what, user approves before save.
- **No UI in 0x010 web app.** Only REST API; extension is the primary interface.
- **Todos not vector-indexed.** Search only covers `facts` and `handoffs`.

## How to continue in a new session

1. Ensure 0x010 has `PROJECT_MEMORY_ENABLED=true` and is restarted.
2. Ensure `pi-project-memory` extension is copied to `~/.pi/agent/extensions/`.
3. Create `.project-id` in project root if not exists.
4. Use tools normally: `project_memory_recent` to catch up, `project_memory_search` to find facts, `project_memory_add` to save progress.

## File checklist

0x010 backend:
- `app/project_memory/__init__.py`
- `app/project_memory/models.py`
- `app/project_memory/store.py`
- `app/project_memory/indexer.py`
- `app/project_memory/service.py`
- `app/web_app.py` (endpoints at bottom)
- `app/config.py` (PROJECT_MEMORY_* fields)
- `app/chat_service/core.py` (service initialization)

Pi extension:
- `pi-project-memory/index.ts`
- `pi-project-memory/package.json`
- `pi-project-memory/README.md`
- `pi-project-memory/AGENTS.md` (this file)
