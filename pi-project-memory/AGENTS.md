# pi-project-memory — Agent Guide

> Loaded together with the root `AGENTS.md`. This file contains only guidance specific to `pi-project-memory`.

## Project memory

This project keeps durable notes about conventions, architecture, patterns, gotchas, historical decisions, and open todos.

- **Recall memory** when the task touches any of those, or after reading relevant files when something still feels project-specific.
- **Start with a focused query** naming the topic, file, pattern, or decision.
- **Glance over the results** and ask for more detail only on the facts that clearly affect the current step.
- **Do not recall** for greetings, generic questions, trivial edits, or when the current files already answer the question.
- **Don't fetch memory automatically** at the start of every session; wait until the task shows it needs project context.

## Backend

- **Backend project:** `C:/10x001/AI comp/0x010`
- **Canonical spec:** `0x010/docs/reference/PROJECT_MEMORY_SPEC.md`
- **Backend module:** `0x010/app/project_memory/`
- **Client API summary:** `pi-project-memory/docs/reference/API.md`

## Important behaviors

- Tools are hidden from the LLM unless `.project-id` exists in `cwd`.
- Backend URL resolution: `PI_PROJECT_MEMORY_URL` → `PI_BACKEND_URL` → `http://127.0.0.1:8000`.

## Source

- `pi-project-memory/index.ts`
