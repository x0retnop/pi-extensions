# Pi Extensions — Dev Collection

Local development workspace for Pi Coding Agent extensions.

## What this is

This repo (`C:/10x001/pi extensions/`) is the **dev workspace**. Extensions are edited and type-checked here, then the user copies them to the Pi runtime folder and restarts Pi.

- **Dev workspace**: `C:/10x001/pi extensions/`
- **Runtime folder**: `~/.pi/agent/extensions/`
- Extensions are **not** installed via `pi install` from this workspace.

See `AGENTS.md` and `docs/pi-workflow.md` for the full workflow.

## Active extensions

```
a-rewind          — guard against fake tool-call announcements; manual rewind
auto-trust        — auto-approve safe commands
context-compressor — lightweight same-model context compression with KEY FACTS
context-guard     — prompt cleanup, tool gating, skill control
grep-tool         — project-wide grep override
model-manager     — dynamic provider/model registration, /mm TUI
pi-multi-edit     — exact-replacement edit tool with batch modes
pi-project-memory — vector project facts + todos via 0x010
pi-session-memory — semantic search over past sessions via 0x010
pi-web-search     — web search/fetch/code search via 0x010 MCP
read-mode         — mode-aware read tool (overview/section/grep/headtail/raw)
role-sw           — role injection and persistence
simple-gate       — path/command permission gate
sub-agents        — child pi agents (/handoff, /sub-agents)
```

Each extension is documented in `docs/extensions/<name>.md`.

## Type-checking

```bash
npm run typecheck
```

Run this before committing code or package changes. Pure documentation changes do not require it, but run it if unsure.

## Dependencies

- Pi core packages (`@earendil-works/*`, `typebox`) are listed as `peerDependencies` in each extension and provided by Pi at runtime.
- Normal npm packages used by an extension are installed once in the shared runtime: `~/.pi/agent/`.
- Dev types are installed in the local `node_modules/` from the root `package.json`.

## Tests

```bash
python scripts/run-tests.py
```

Compiles and runs the unit-test suite in `tests/unit/`. Run it alongside `npm run typecheck` for code changes.

## Documentation

- `AGENTS.md` — quick rules and navigation (auto-loaded by Pi).
- `docs/agent-nav.md` — "where do I look?" index.
- `docs/pi-workflow.md` — dev vs runtime, sync, dependencies.
- `docs/pi-version-sync.md` — Pi CLI upgrade workflow.
- `docs/pi-local-map.md` — where Pi types live locally.
- `docs/pi-quickref.md` — ExtensionAPI events/tools/commands.
- `docs/pi-tool-internals.md` — tool visibility, substitution, rendering.
- `docs/tool-rendering.md` — renderCall/renderResult pitfalls.
- `docs/0x010-control.md` — start/stop/restart the 0x010 backend runtime.
- `docs/interactions.md` — cross-extension and runtime wiring map.
- `docs/extensions/<name>.md` — per-extension agent guide.
- `docs/git-policy.md` — how agents commit in this shared repo.

## Git

Agents manage git locally: small prefixed commits, no push. See `docs/git-policy.md`.

## Notes

- The previous install-centric README is obsolete; these extensions are developed locally and deployed manually.
- Extension lifecycle (enable, disable, copy to runtime, archive) is managed by the user, not by agents.
