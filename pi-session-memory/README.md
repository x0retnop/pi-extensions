# pi-session-memory

Local session browser + Markdown export. **No backend, no agent tool.**

The Session Vector Index path (agent tool `session_memory`, semantic search) was removed on
2026-09-20 — the backend was never running and the tool was gated off by `context-guard`.

## Commands

- **`/sw`** — switch session. Enter = real session switch. Tab = scope (project → current → by project → all). `/` = incremental filter. P = chat-style head preview. E export · D delete.
- **`/sm`** — hub: Open · Export session to Markdown. Export "Choose another session…" uses the same browser (Enter picks, P previews).

Inject-into-editor “resume” is gone. Prefer `/sw` over built-in `/resume` when you have many sessions.

## Export

Local Markdown: `chat`, `outline`, `outline-reasoning`, `full`, `reasoning`, `real-full`.

## Requirements

None — everything reads `~/.pi/agent/sessions/` directly.

## Source

- `index.ts` — command wiring, viewer/export/browser actions
- `local-sessions.ts` — scoped local list + head-scan preview
- `session-browser.ts` / `session-viewer.ts` — TUI picker and viewer
- `local-export.ts` — Markdown export
- `project.ts` — path / cwd helpers
