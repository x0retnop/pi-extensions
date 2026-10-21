# Pi Extensions — an agent-driven harness for Pi Coding Agent

A working setup for [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): 19 TypeScript
extensions, shared helpers, tooling scripts, unit tests, and the documentation that ties them
together — all of it developed against a live Pi install rather than in a vacuum.

**It is built to be read and driven by an LLM agent, not by a human.** The entry point is
[`AGENTS.md`](AGENTS.md): a map written for an agent — which folder owns what, which command
gates a change, which doc answers which question. The docs are dense, English, and assume an
agent does the reading.

If you are a person: don't try to assemble this by hand. Install Pi, open this folder in it,
and ask the agent to explain the layout and adapt it to your machine. That is the intended
path, and it is the only one that works without reading a few hundred pages first.

## What's inside

| Path | What it is |
|---|---|
| `<name>/` | One folder per extension (`index.ts` + `package.json`), 19 of them — status bar, roles, sub-agents, rewind, model manager, UI theme, guards, web search |
| `common/` | Shared TypeScript helpers used by several extensions (chrome, status, paint, retry policy) |
| `scripts/` | Build, deploy, test and forensics tooling — Python, run from the repo root |
| `docs/` | The knowledge base: per-extension behaviour, hard-earned pitfalls, Pi API notes |
| `tests/unit/` | Unit tests, run with `python scripts/run-tests.py` |
| `sync-extensions.ps1` | Deploys the compiled extension tree into `~/.pi/agent/extensions` (Windows/PowerShell) |

## Quick start

1. Install Pi: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, then run `pi`
   once and authenticate (`/login` or a provider API key).
2. Clone or copy this repo somewhere writable.
3. Run `pi` in the repo root and say: *"Read AGENTS.md, tell me what this harness does and what
   is missing on my machine."* The agent will read the map and the docs it points at.
4. To actually enable extensions: `python scripts/build-extensions.py`, then
   `pwsh -NoProfile -File ./sync-extensions.ps1 -NoWait`, then restart Pi. Extensions load from
   compiled `.js` in the runtime folder, never from `.ts`.

Deployment is Windows-specific (PowerShell + a runtime path under your home directory). On other
platforms the extensions themselves are portable, the sync script is not.

## How a change works

`npm run typecheck` gates every `.ts` / `package.json` change; docs-only edits skip it.
Behaviour changes get a line in the private experience log when they cost a debugging session,
and a decision note when the reason is not obvious from the code. Nothing here is generated
busywork — every document exists because a future agent needed it.

## About this public snapshot

This repository is a filtered snapshot of a private working tree. Two things stay private by
policy: notes about **local projects and services**, and anything that says **which providers,
models or accounts** the machine actually talks to (provider/quota/oauth notes, measured
traffic, the dated experience log). Docs about *how the harness works* are published as-is.

References to a missing doc mean exactly that. The subset is rebuilt from the private tree and
pushed as one synthetic branch, so the public history contains only what was reviewed for
publication. The publishing rules themselves (`publish-ignore.txt`, `publish-scrub.txt`,
`publish-scan.txt`) stay private — they name the excluded paths.

## License

MIT — see [`LICENSE`](LICENSE). The Pi docs snapshot in `docs/off-doc-llm/` is adapted from the
MIT-licensed `@earendil-works/pi-coding-agent` package.

## Contact

Serious enquiries only: adapting this harness to your environment, integration or setup work,
paid consulting, or a concrete collaboration/development proposal. Open an issue here, or reach
out on Telegram: [@x0retnop](https://t.me/x0retnop).

"What is this", "why does it exist", "can you explain X" — the repository is the answer; start an
agent in it. Short one-liners are ignored.
