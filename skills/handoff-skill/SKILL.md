---
name: handoff
description: "Generate a tactical handoff for the Personal Local Assistant Runtime project (C:/10x001/AI comp/0x010) to transfer context to a new Pi session. Use when: (1) context is large or slow, (2) user says 'handoff', 'new session', 'continue in fresh chat', (3) switching tasks after substantial work on this project, (4) session end. Proactively suggest after 5+ file edits, complex debugging, architecture decisions, or contract changes."
---

# Handoff

This skill is tailored for the **Personal Local Assistant Runtime** project. It separates long-lived project context from tactical session state, following the project's own documentation hygiene rules in `AGENTS.md`.

> **Distinction:** `AGENT_CONTEXT.md` is the project's current-state handoff. This skill produces a **new-session handoff prompt** that may update `AGENT_CONTEXT.md` as part of its pre-flight, but the final deliverable is a copy-paste prompt for `/new`.

## Mode Selection

Determine the mode before acting:

**CREATE?** User wants to save state, start a new session, or context is full.
→ Follow the **CREATE** flow below.

**RESUME?** User pasted a previous handoff or says "continue where I left off" on this project.
→ Follow the **RESUME** flow below.

---

## CREATE Flow

### Step 1: Pre-flight — documentation hygiene

Follow the project's `AGENTS.md` doc maintenance policy:

1. **Read `AGENT_CONTEXT.md`** (project root). It contains the current state, backend shape, important files, and next likely work.
2. **Read `AGENTS.md`** (project root) to confirm startup sequence and doc rules.
3. **Update the smallest relevant active doc** if this session changed behavior, workflow, architecture, contracts, or verified baselines.
   - Code changes → update `docs/AGENT_RUNTIME_GUIDE.md` or `docs/CONTRACTS.md` if contracts changed.
   - Stage/module changes → update the relevant `docs/stages/*.md` file.
   - New operational commands/checks → update `docs/OPERATIONS.md`.
   - Roadmap shifts → update `docs/ROADMAP.md`.
4. **Update `AGENT_CONTEXT.md`** for current-state handoff changes only:
   - Current implementation status (what stages are done/in-progress).
   - Current backend shape (typical `.env` baseline).
   - Next likely work.
   - Avoid list updates.
   - Important files list if new modules were added or paths changed.
5. **Update `changes.txt`** for meaningful behavior, workflow, architecture, contract, or baseline changes. Use the existing date-prefixed line format.
6. **Move obsolete plans/notes** to `docs/archive/` instead of leaving them as active guidance.
7. **Do not** duplicate generic agent rules or static project background into the handoff prompt. The prompt must be tactical.

### Step 2: Collect environment state

Run via bash:

```bash
git branch --show-current 2>/dev/null
git log --oneline -5 --no-decorate 2>/dev/null
git diff --name-only 2>/dev/null
git diff --name-only --cached 2>/dev/null
pwd
```

Read `.env` to capture the current backend shape (model, reasoning policy, vector mode, native tools, etc.).

Find active stage docs that are relevant to the current work:

```bash
find docs/stages -name "*.md" -type f | sort
```

### Step 3: Resolve goal

- If the user provided an argument (e.g., `/skill:handoff finish PC Action Gateway wiring`), use it verbatim as **Next Goal**.
- If no argument was given, check `AGENT_CONTEXT.md` "Next likely work". If it is clear and still relevant, use it. If ambiguous or stale, ask the user: "What should the next session focus on?"

### Step 4: Generate the handoff

Use the **Handoff Template** below. **Fill every section.** If a section genuinely does not apply, write "N/A" and one-sentence reason why.

**Extraction rules for this project:**
- **Do not duplicate committed memory.** The runtime stores confirmed long-term memory in `data/standard/memory/committed/*.md`. The next session will read it via the memory pipeline. Only mention memory-relevant facts if they are **not yet committed** (e.g., new preferences or facts pending review).
- **Do not duplicate static project background** found in `docs/PROJECT_OVERVIEW.md` or `docs/PERSONAL_ASSISTANT_DIRECTION.md`. The handoff is tactical.
- **File paths for code:** relative to project root.
- **File paths for reference docs:** absolute or repo-root-relative so the next session can open them directly.
- **No code snippets, API keys, tokens, passwords, connection strings.** Environment variable names only.
- **Decisions must include alternatives considered and rationale.** This project values explicit decision tracking.
- **Gotchas are mandatory.** List at least one pitfall, hidden dependency, or side effect specific to this codebase (e.g., "Gemma hard-off requires `chat_template_kwargs.enable_thinking=false`", "Web transcript is UI data, not committed memory", "Vector memory must fail soft").
- **Include `.env` baseline** in Metadata so the next session knows the current backend shape without guessing.

### Step 5: Security check

Before delivering, verify mentally:
- [ ] No secrets (API keys, tokens, passwords, connection strings with credentials)
- [ ] Code paths are relative; doc paths are absolute or repo-root-relative
- [ ] No `[TODO]` or placeholder text left in the handoff
- [ ] Obsolete guidance was moved to `docs/archive/`, not left in active docs

If secrets are detected, remove them and warn the user.

### Step 6: Deliver

Present the handoff inside a single markdown code block titled `handoff-prompt`. Then tell the user:

> Copy the block above, run `/new`, paste it into the editor, and press Enter.

If the `write` tool is available, you may also write the handoff to `.pi/handoff-prompt.md` and tell the user to read it after `/new`.

---

## Handoff Template

Generate EXACTLY in this format:

````markdown
# Handoff Context
You are continuing work on the Personal Local Assistant Runtime project. Use the context below and focus only on the goal at the bottom. Do not mention the handoff itself.

## Metadata
- **Project:** Personal Local Assistant Runtime
- **Path:** C:/10x001/AI comp/0x010
- **Branch:** [current git branch]
- **Date:** [timestamp]
- **Continues from:** [previous handoff title, or "Initial session"]
- **Supersedes:** [older handoffs this makes obsolete, or "None"]
- **.env baseline:** [key env vars: MODEL_FAMILY, CHAT_REASONING_POLICY, MEMORY_VECTOR_MODE, NATIVE_TOOLS_ENABLED, etc.]

## Current State
[One paragraph: what stage/module was being worked on, where it stopped, what is working, what is broken. Be specific. Reference implementation stages from docs/stages/ if applicable.]

## What was done
- [x] [Completed task with concrete result — include relative file paths if applicable]
- [x] ...

## What did NOT work (and why)
- [Approach or command] — [specific reason, include error message if available]
- ...

## Key decisions
| Decision | Alternatives considered | Why this choice |
|----------|------------------------|-----------------|
| [Decision 1] | [Option A, Option B] | [Rationale] |

## Reference documents (read before continuing)
Use the project's startup sequence from `AGENTS.md`:
1. `AGENT_CONTEXT.md` — current state handoff.
2. `docs/README.md` — doc and code map.
3. `docs/AGENT_RUNTIME_GUIDE.md` — practical code guide.
4. `docs/CONTRACTS.md` — runtime/memory/Web/reasoning contracts.
5. `docs/OPERATIONS.md` — commands and targeted checks.
6. `docs/ROADMAP.md` — staged roadmap.
7. `changes.txt` — recent meaningful changes.

Active stage docs for this work:
| Doc | Why it matters |
|-----|---------------|
| `docs/stages/[STAGE_NAME].md` | [Brief reason] |

## Relevant files
| File | What it is/does | Status |
|------|----------------|--------|
| `relative/path/to/file` | [description] | [modified / created / unchanged] |

## Pending / Next steps
1. [ ] [Most critical action — what to do first]
2. [ ] [Second priority]
3. [ ] [Third priority]

## Blockers / Open questions
- [ ] [Blocker or question — what is needed to resolve it]

## Gotchas
- [Non-obvious pitfall, hidden dependency, or side effect specific to this codebase]
- ...

## Avoid (carry forward)
- [ ] Do not write one-shot or temporary style into committed memory.
- [ ] Do not treat notes, Web search, activity events, action results, or chat transcripts as committed memory automatically.
- [ ] Do not mix reasoning traces into final answers, history, session state, or memory.
- [ ] Do not make vector memory mandatory.
- [ ] Do not add unrestricted shell access, keylogging, screenshots/OCR loop, browser-history ingestion, or full-disk indexing without explicit direction.
- [ ] Do not run servers, `.bat` files, models, or long-running processes without explicit user command.

## Next Goal (verbatim)
[The user's argument, or inferred goal if none provided]
````

---

## RESUME Flow

When the user pastes a handoff or asks to resume on this project:

1. **Read `AGENT_CONTEXT.md`** first. It is the project's current-state handoff.
2. **Read the pasted handoff** fully.
3. **Follow the project's startup sequence** from `AGENTS.md`:
   - `docs/README.md` as the map.
   - `docs/AGENT_RUNTIME_GUIDE.md` for implementation tasks.
   - `docs/CONTRACTS.md` for contract-sensitive changes.
   - `docs/OPERATIONS.md` for commands and checks.
   - Open reference docs only when the task touches that area.
4. **Verify environment:**
   ```bash
   git branch --show-current
   git status
   git log --oneline -5
   ```
   Check `.env` matches the handoff baseline.
5. **Validation checklist:**
   - [ ] Current branch matches (or understand why it changed)
   - [ ] Listed files still exist
   - [ ] Assumptions are still valid
   - [ ] Blockers have been resolved or are still pending
   - [ ] Read the "Gotchas" section to avoid known pitfalls
   - [ ] Read relevant **Reference documents** before continuing
6. **Run targeted checks** from `docs/OPERATIONS.md` if the handoff suggests verification (e.g., after runtime or contract changes).
7. **Begin with Pending item #1**.
8. **Update or chain:** as work progresses, mark items complete. If the session grows long, generate a new handoff referencing this one via "Continues from".

---

## Rules

1. **Fill every section.** The next session must understand everything without asking.
2. **Do not duplicate committed memory or static project docs.** Keep the handoff tactical.
3. **Relative paths for code, clear paths for docs.** Reference documents must be findable so the next session can read them directly.
4. **No code snippets in the handoff.** Only file references. The new session reads files itself.
5. **No secrets.** Never include API keys, tokens, passwords. Environment variable names only.
6. **Decisions with rationale.** Not just "chose X", but "chose X because Y failed due to Z".
7. **Gotchas are mandatory.** Always list at least one pitfall or hidden dependency specific to this codebase.
8. **Update project docs first.** Before generating the handoff, sync `AGENT_CONTEXT.md`, `changes.txt`, and any active stage docs so the handoff stays current and short.
9. **Copyable format.** Output must be a single markdown block the user copies and pastes into `/new`.
