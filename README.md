# Pi Extensions

A small collection of Pi extensions. Each folder is a standalone Pi package that can be published or installed separately.

Tested and known to work with Pi v0.72.1 or newer.

## Extensions

### A Rewind

Auto-guards against assistant messages that announce tool use but do not emit real tool calls. Also adds manual rewind for the latest assistant message.

Recent reliability updates: guarded message handling and safer internal marker strings.

```bash
pi install git:github.com/x0retnop/pi-extension-a-rewind
```

### AskU

Adds `ask_user_question`, an interactive TUI tool for structured clarifying questions. Supports choice mode (2-4 options) and open mode (free-text). Adapted from [`ghoseb/pi-askuserquestion`](https://github.com/ghoseb/pi-askuserquestion) for this collection.

```bash
pi install ./asku
```

### BTW

Ask quick side questions with `/btw` using the current conversation as bounded context, without adding the question or answer to session history.

Recent reliability update: large sessions use a bounded context slice.

```bash
pi install git:github.com/x0retnop/pi-extension-btw
```

### Context

Shows loaded context files, extensions, skills, active tools, and approximate token usage.

```bash
pi install git:github.com/x0retnop/pi-extension-context
```

### Context Manager

Manual context helper with `/ctx`, status toggles, manual compaction, and handoff helpers.

Recent reliability update: session-local status/timing state is reset on session changes.

```bash
pi install git:github.com/x0retnop/pi-extension-ctx-manager
```

### Handoff

Generates a focused handoff prompt from the current session and starts a new session with it pre-filled.

Recent reliability updates: bounded extraction context, more tolerant JSON parsing, and progress cleanup/timeout abort safeguards.

```bash
pi install git:github.com/x0retnop/pi-extension-handoff
```

### Ollama Cloud Web

Adds `web_search` and `web_fetch` tools powered by Ollama Cloud.

Recent reliability update: defensive auth lookup and clearer errors for unreadable or malformed `auth.json`.

```bash
pi install git:github.com/x0retnop/pi-extension-ollama-cloud-web
```

### Permission Gate

Unified safety gate for `bash`, `read`, `write`, and `edit` tool calls. Uses structural command analysis and a path-aware decision engine instead of regex heuristics.

- **Bash**: Parsed into segments/pipelines/compounds. Risk is determined by a `CommandDB` (190 commands, 576 subcommands) rather than fragile regex. Inline Python/Node scripts are scanned for write/delete/network/execute patterns.
- **Read/write/edit**: Path is classified as `inside_project`, `outside_project`, or `protected`. Protected roots are hard-blocked. Writes and edits outside the project require double confirmation.
- **YOLO safe-read outside project**: In `yolo` mode, read-only commands (`ls`, `cat`, `rg`, `grep`, `find`, `head`) targeting paths outside the project are allowed automatically. Redirections to `/dev/null` or `nul` do not count as write risk.
- **Hard blocks**: Destructive commands (`rm -rf /`, `git reset --hard`, `format`, `diskpart`, `curl | sh`) are blocked without asking.
- **Visual approvals**: Risk emoji (🟢 read, 🟡 write, 🔴 delete, ⛔ destructive) and structured prompt text for faster scanning.

Four selectable modes — strict, balanced, relaxed, and yolo — with a live status indicator and `/gate-mode` command to switch or cycle at runtime.

- `strict` — safest, most commands require confirmation.
- `balanced` — default-style allow list plus confirmations for risky commands.
- `relaxed` — auto-allows read-only lookups, safe inline Python/Node, pipelines, and compounds. Recommended for day-to-day agent work.
- `yolo` — minimal friction for focused project work. Hard blocks and destructive operations still ask; write/delete outside the project asks; safe read outside the project is allowed.

Recent update: YOLO safe-read outside project, visual approval prompts, Git Bash path support (`/c/...`), `find -exec/-delete` flags, and null-redirect handling.

```bash
pi install git:github.com/x0retnop/pi-extension-permission-gate
```

### Protected Paths (deprecated)

**Merged into Permission Gate.** All path-protection features are now part of the unified gate. If you previously used `protected-paths`, disable or remove it and rely on `permission-gate` alone.

```bash
pi install git:github.com/x0retnop/pi-extension-protected-paths
```

### Request Inspector

Capture and inspect exactly what Pi sends to the LLM provider. Dumps system prompt, messages, tool definitions, and the full raw payload into a clean markdown file.

- `/inspect` — Save the last request to `./.pi-inspect/inspect-<timestamp>.md`.
- `/inspect-toggle` — Toggle auto-save for every request.

```bash
pi install ./pi-request-inspector
```

### Skill Guard

Control which skills reach the LLM. Disable automatic skill injection globally, or manually inject a specific skill on demand.

- `/skills` — Show auto-skill status and loaded skills.
- `/skills-toggle` — Turn automatic skill injection ON / OFF.
- `/use-skill <name> [comment]` — Queue a skill for manual injection into the next turn.

```bash
pi install ./pi-skill-guard
```

### Role Switcher

Switch between preset agent roles via `/role`. Uses an interactive TUI select when called without arguments, or accepts a role name directly (e.g., `/role code_auditor`).

Roles are loaded from `~/.pi/agent/roles/` and the active role is persisted in the session — it survives reloads and `/resume`.

```bash
pi install ./role-sw
```

### Sessions

Adds `/sessions`, an interactive lazy-loading picker for switching between recent Pi sessions.

Recent performance update: session previews are loaded lazily in small batches.

```bash
pi install git:github.com/x0retnop/pi-extension-sessions
```

### Temperature / Model Utility

Adds `/tm` to set LLM temperature at runtime, plus automatic temperature injection before provider requests. Detects Kimi provider and strips unsupported sampling parameters.

```bash
pi install ./tm
```

### Todo

Adds a model-callable todo checklist tool for larger tasks, plus `/todos` and `/todo-mode` commands.

```bash
pi install git:github.com/x0retnop/pi-extension-todo
```

### Win Bash Sanitizer

Sanitizes `bash` tool calls for Git Bash on Windows. Automatically fixes common Windows-to-Bash translation mistakes (`2>nul`, `dir`, backslash escapes, unbalanced quotes) before execution.

```bash
pi install ./win-bash-sanitizer
```

## AGENTS.md

This repository also includes an `AGENTS.md` example for shaping how the coding agent works. It favors practical, low-noise, project-local changes: do useful work first, keep explanations brief, avoid broad cleanup, verify small edits, and ask before risky or non-local actions.

The most useful sections to customize are:

- `Priority and defaults` — language, response style, and reporting style.
- `Autonomy and judgment` — when the agent may act without asking.
- `Scope and edits` — what files and changes are in scope.
- `Verification and safety` — what checks are allowed and what actions require permission.
- `Environment and commands` — OS, shell, scripting preferences, and Windows-friendly command guidance.
- `Safety extensions` — how relaxed `permission-gate` and `protected-paths` modes should affect agent behavior without broadening scope.

`permission-gate` pairs well with this style: `AGENTS.md` tells the model how to behave, while the gate adds runtime guardrails for commands, file reads, writes, and edits.

## Local install after cloning this repository

```bash
git clone https://github.com/x0retnop/pi-extensions.git
cd pi-extensions
pi install ./btw
```

Replace `./btw` with any extension folder name, for example `./asku`, `./grep-tool`, `./pi-kimi`, `./todo`, `./sessions`, `./tm`, `./win-bash-sanitizer`, or `./permission-gate`.
