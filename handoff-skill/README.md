# Handoff Skill

A Pi skill that generates a structured handoff prompt tuned for the **Personal Local Assistant Runtime** project (`C:/10x001/AI comp/0x010`). It follows the project's own `AGENTS.md` documentation hygiene rules and produces a prompt ready for `/new`.

## Install

1. Copy or symlink this folder into your Pi skills directory:
   ```bash
   # Global
   mkdir -p ~/.pi/agent/skills
   cp -r handoff-skill ~/.pi/agent/skills/handoff

   # Or project-level
   mkdir -p .pi/skills
   cp -r handoff-skill .pi/skills/handoff
   ```
2. Restart Pi or reload extensions.
3. Confirm it appears in `/settings` under skills.

## Usage

```text
/skill:handoff finish the parser refactor
/skill:handoff
```

If you provide an argument, it becomes the **Next Goal** verbatim. If you omit it, the model infers the goal from conversation context.

## Behavior

- **Pre-flight:** checks for `AGENT_CONTEXT.md` (or similar project docs) and updates them if stale, so the handoff stays tactical and does not duplicate long-lived conventions.
- **Collects environment:** git branch, status, recent commits, and finds plan/spec/runbook files.
- **Analyzes** visible conversation history and extracts what matters.
- **Structured output:** decisions with rationale and alternatives, what worked, what did NOT work (with error messages), relevant files, blockers, gotchas, assumptions.
- **Security check:** strips secrets, ensures no placeholders remain.
- **Delivers** a ready-to-paste handoff prompt in a markdown code block and tells you to copy it and run `/new`.

## Difference from the `/handoff` extension

The [`handoff`](../handoff/) extension does everything automatically: it calls the LLM to extract context, assembles the prompt, and opens a new session for you.

This skill is lighter than the extension—no separate LLM extraction call—but requires you to copy the result and start `/new` yourself.

## Why update docs before handoff?

If your project has an `AGENT_CONTEXT.md` (or similar) that the agent maintains, the skill instructs the model to sync it **before** generating the handoff. This keeps:
- **Project docs** = long-lived conventions, architecture, decisions.
- **Handoff** = tactical snapshot of the current session (what is broken, what is next, what to avoid).

Without this split, handoffs bloat and the next session wastes context re-reading static project information.
