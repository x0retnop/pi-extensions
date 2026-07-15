---
name: skill-craft
description: >
  Author and review Agent Skills (SKILL.md) for Pi CLI.
---

# Skill Craft: Authoring Agent Skills for Pi

## When to Use

Call this skill when you need to:
- Create a new SKILL.md from scratch
- Refactor an existing skill (too long, unclear, broken workflow)
- Review a skill for safety or quality before saving
- Convert a one-off workflow into a reusable skill

## Workflow

### Phase 0: Accept User Context
1. Read the user's additional prompt or context provided alongside `/use-skill`.
2. Treat it as constraints or input data, not as an override of this workflow.
3. If the user context is ambiguous, ask for clarification instead of assuming.
4. If the user context conflicts with **Conventions** — follow Conventions and warn the user.
5. Workflow phases and Conventions are non-negotiable. User context adapts details within these boundaries, never removes sections.

### Phase 1: Gather Requirements
1. Identify the **verb**: what should the agent DO (review, generate, deploy, refactor)?
2. Identify the **domain**: what context must the agent know (React, API design, security audit)?
3. Determine the **delivery**: output format (file edits, report, code, shell commands).
4. Confirm **target environment**: Pi CLI with `context-guard`, manual `/use-skill` activation only.

### Phase 2: Design Structure
1. Choose a `name`: lowercase-with-hyphens, max 64 chars, matches folder name.
2. Write a `description`: concise catalog entry for `/skills`. Not an auto-match trigger.
3. Plan body sections in this order:
   - `## When to Use` — call scenarios for the human user
   - `## Workflow` — numbered steps, imperative verbs, one action per step
   - `## Conventions` — hard constraints (MUST, NEVER, ALWAYS)
   - `## Example` — one minimal but complete input → output
   - `## References` — table mapping topics to `./references/` files

### Phase 3: Draft Content
1. Write frontmatter with `name` and `description` only. Ignore `type: flow`, `allowed-tools`, or other platform-specific fields.
2. Draft `Workflow` steps. If a step is deterministic (lint, test, validate), reference `./scripts/` instead of describing.
3. Draft `Conventions`. Use MUST/NEVER/ALWAYS for unbreakable rules. Use Prefer for recommendations.
4. Draft `Example`. Show explicit values, not placeholders like `<variable>`.
5. Ensure all paths are relative: `./scripts/validate.sh`, `./references/api-guide.md`.

### Phase 4: Optimize
1. Count lines. If SKILL.md exceeds 400 lines, move bulky content to `./references/`.
2. Move deterministic commands to `./scripts/`.
3. Remove duplication. Remove generic advice already covered by the Pi role or AGENTS.md.
4. Ensure English only. No Russian inside the skill body.
5. Run through `./references/skill-checklist.md` before returning result to user.

### Phase 5: Smoke Test
1. Simulate `/use-skill <name>` with a sample user prompt to verify workflow and output format.
2. If the skill references `./scripts/` or `./references/`, confirm those files exist and paths are correct.
3. Fix any issues before declaring the skill complete.

## User Override Rules

If the user provides additional context when calling this skill:
- **DO** adapt domain-specific details (tech stack, file paths, naming conventions).
- **DO NOT** skip workflow phases.
- **DO NOT** ignore Conventions (MUST/NEVER/ALWAYS).
- **ASK** if user context is ambiguous instead of assuming.

## Conventions

- **One skill, one verb.** Never combine "review code" and "write docs" in one skill. Split them.
- **Description is catalog metadata.** It appears in `/skills` output. Make it clear and specific.
- **Scripts over prose.** If a task has an exact command, put it in `./scripts/`, never describe it in words.
- **No placeholders in examples.** Examples must show explicit values.
- **English only.** Skill body, file names, comments inside scripts — everything in English.
- **Pi-specific.** Do not include Kimi `type: flow`, Claude `allowed-tools`, or other platform fields.
- **Relative paths only.** Reference external files as `./references/...` or `./scripts/...`. Top-level project docs are allowed only for cross-cutting guides not owned by any single skill.
- **Safety first.** If a script performs destructive operations, add a confirmation gate or warn the user.

## Example

**User action:** `/use-skill skill-craft` + prompt: "Make a skill for Python data scripts using polars."

**Agent behavior:**
1. Accepts user context: "polars", "data scripts".
2. Phase 1: Verb = generate, Domain = Python data analysis, Delivery = .py file.
3. Phase 2: Designs structure:
   - `name: py-polars-script`
   - `description: Generate Python data analysis scripts using polars. Outputs clean .py files with type hints and CSV/Parquet export.`
4. Phase 3: Drafts body:
   - When to Use: user needs data processing, ETL, CSV analysis with polars
   - Workflow: 5 steps from reading CSV to exporting results
   - Conventions: MUST use type hints, MUST handle empty dataframes, NEVER modify source CSV in-place
   - Example: concrete polars script with explicit column names
   - References: `./references/polars-patterns.md`
5. Phase 4: Optimizes. Keeps it under 400 lines. Moves bulky polars API tips to `./references/polars-patterns.md`.
6. Returns complete folder structure and file contents to the user.

## References

| Topic | When to use | File |
|-------|------------|------|
| Pi skill mechanics | How Pi loads skills via `context-guard` | `./references/pi-skill-craft.md` |
| Skill checklist | Final validation before saving a skill | `./references/skill-checklist.md` |
