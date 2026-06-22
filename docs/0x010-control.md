# 0x010 Backend Control

Three Pi extensions (`pi-web-search`, `pi-project-memory`, `pi-session-memory`) talk to the 0x010 backend at `http://127.0.0.1:8000` by default.

This backend is part of the 0x010 project (`C:/10x001/AI comp/0x010/`). Control it through the 0x010 Agent HTTP API at `127.0.0.1:18080` instead of killing Python processes manually.

## API endpoints

```
GET  /status
POST /{main|embedding|runtime}/{start|stop|restart}
```

- `GET /status` returns JSON with `main`, `embedding`, and `runtime` status blocks.
- `POST /runtime/restart` is the standard way to reload runtime code changes.

## Shortcuts

From the 0x010 project directory:

```bash
# status
task server:status
# or
xh GET http://127.0.0.1:18080/status

# restart only the runtime after backend code changes
task server:restart C=runtime
# or
curl -X POST http://127.0.0.1:18080/runtime/restart

# stop / start runtime
task server:stop C=runtime
task server:start C=runtime
```

## Rules of thumb

- Restart `runtime` freely when 0x010 extension code changes.
- Do **not** casually restart `main` or `embedding`; they are model-heavy.
- `main` and `embedding` should only be restarted if they are actually stuck or after model/profile changes.

## Endpoints used by Pi extensions

| Extension | Endpoint |
|-----------|----------|
| `pi-web-search` | `GET /api/web_research/status`, `POST /mcp` |
| `pi-project-memory` | `POST /api/project_memory/*` |
| `pi-session-memory` | `GET/POST /api/session_index/*` |

## Troubleshooting

1. Check overall status: `xh GET http://127.0.0.1:18080/status`.
2. If `runtime` is not running, start it: `xh POST http://127.0.0.1:18080/runtime/start`.
3. If runtime is running but returning errors, restart it: `xh POST http://127.0.0.1:18080/runtime/restart`.
4. If the MCP endpoint returns 406, ensure the `Accept` header includes `text/event-stream`; the 0x010 MCP transport is streamable-http.

For deeper operations and emergency fallbacks, see `C:/10x001/AI comp/0x010/docs/OPERATIONS.md`.
