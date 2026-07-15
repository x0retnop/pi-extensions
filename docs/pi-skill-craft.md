# Pi Skill Craft: Writing and Using Skills in Pi + context-guard

> **Purpose:** agent-facing guide to skills in the Pi CLI + `context-guard` setup.
> **Usage model:** manual activation only via `/use-skill`. Auto-injection is off. Skills live in one place.

---

## 1. How it works (mechanics)

### 1.1 Where skills live

```
C:\Users\user\.pi\agent\skills\
├── some-skill.md           # simple skill
├── another-skill/          # or a folder
│   └── SKILL.md
└── ...
```

`context-guard` looks **only here**. Dev copies of skills are edited in this repo under `skills/` and copied over manually.

### 1.2 How the user activates a skill

```
/use-skill <name> [comment]
```

Examples:
- `/use-skill refactor-code rewrite this method to async/await`
- `/use-skill py-review` (no comment — a placeholder is used)

### 1.3 What happens under the hood

1. `context-guard` finds the skill file by name.
2. **Frontmatter is stripped.** Only the body (everything after the second `---`) goes into the system prompt.
3. The body is wrapped as `\n\n## Skill: <name>\n\n<body>` and **appended to the system prompt** via `before_agent_start`.
4. The `comment`, if given, becomes a **user message**. Otherwise a placeholder `Applying skill: <name>` is used.

### 1.4 What this means for the agent

- The agent does **not** pick a skill itself. The user **explicitly chose** it via `/use-skill`.
- The skill is already **inside the system prompt** by the time the agent answers. Follow its instructions.
- The user's **comment** is the concrete task. The skill is the procedure. Combine: procedure from the skill + specific request from the comment.
- A skill may contain `MUST`, `NEVER`, `ALWAYS` — hard constraints for the current turn.

---

## 2. SKILL.md format

### 2.1 Structure

```markdown
---
name: skill-name
description: >
  Short description for the /skills catalog. Not used for auto-matching.
  Max 1024 chars.
---

# Skill Name

## When to use
When exactly this skill applies. 1–2 sentences.

## Workflow
1. Step one.
2. Step two.
3. Step three.

## Conventions
- MUST: hard rule.
- NEVER: prohibition.
- Prefer: recommendation.

## Example
Concrete example: input → expected behavior.

## References
| Topic | When needed | File |
|------|------------|------|
| ...  | ...        | `./references/...` |
```

### 2.2 Frontmatter rules

| Field | Rule |
|---|---|
| `name` | Matches the file/folder name. lowercase-with-hyphens. No spaces. |
| `description` | For the `/skills` catalog. Not for auto-matching. Brief: what it does. |

**Ignore other fields (`type: flow`, `allowed-tools`, etc.)** — they target other agents.

### 2.3 Skill directory

For complex skills:

```
skill-name/
├── SKILL.md              # required
├── references/           # large references
└── scripts/              # bash scripts for deterministic steps
```

> **Limit:** SKILL.md must be **< 500 lines**. Everything bulky goes to `references/`. The tighter and more concrete the instruction, the more precisely it is followed. Noise in a skill = risk of key rules being ignored.

---

## 3. How the agent should work with a skill

### 3.1 When a skill is active

The user typed `/use-skill <name> [comment]`. The agent sees:
1. In the system prompt: `## Skill: <name>` + skill body.
2. In a user message: either the `comment` or `Applying skill: <name>`.

### 3.2 Agent algorithm

1. **Read** `## Skill: <name>` from the system prompt.
2. **Read** the user message (concrete request or placeholder).
3. **Follow the skill's Workflow** step by step.
4. **Apply Conventions** as hard constraints.
5. If the comment conflicts with the skill — **the skill wins**. If the conflict is critical — ask the user.
6. If the skill says `Run ./scripts/...` — run it via the bash tool.
7. If the skill references `./references/...` — read it via the read tool.

### 3.3 Important nuances

- **Do not improvise instead of running a script.** If the skill says "Run `./scripts/validate.sh`" — run the script, don't paraphrase its contents.
- **Do not echo what is already in the system prompt.** If the skill is loaded, don't quote it in full in the reply — just follow it.
- **The comment is context.** `/use-skill refactor-code remove duplication in UserService` means: apply the `refactor-code` workflow to the specific file `UserService`.
- **Placeholder:** if there is no comment (`Applying skill: <name>`), the user likely just wants the workflow followed as-is.

---

## 4. Best practices for Pi

### 4.1 Size — brevity beats volume

Pi's system prompt is minimal compared to heavy native agents (Claude Code, Codex CLI, etc.). That is an advantage: a skill does not compete with kilobytes of persona and tool schemas. But the rule stands:

- SKILL.md: **< 500 lines**.
- Large references: in `references/`, read by link only when needed.
- Deterministic commands: in `scripts/`, not inline in the text.

**Why it matters:** the denser and more concrete the instruction, the higher the chance the agent follows it literally instead of ignoring parts buried in filler.

### 4.2 One skill — one verb

Don't mix "review code" and "write docs". Split them.

**Bad:** skill "do everything with React"
**Good:** `react-component-create`, `react-review`, `react-test-write`

### 4.3 Description for the catalog

Since auto-matching is off, `description` is not a trigger but **help text for the user** in `/skills`. Write clearly, but don't spend half your time on it.

### 4.4 Paths

All paths in a skill are relative to the skill folder:
- `./scripts/validate.sh`
- `./references/api-guide.md`

When reading, the agent uses the absolute path, knowing where `SKILL.md` lives.

### 4.5 Safety

If a skill contains shell commands:
- Check for destructiveness before running (`rm`, `git reset`, etc.).
- If the skill says "run X" and X is potentially destructive — confirm with the user, **even if the skill doesn't ask for confirmation**. A skill is a procedure, but the system safety rule ranks higher.

---

## 5. Template: ready-made SKILL.md

Copy and adapt:

```markdown
---
name: my-skill
description: >
  What this skill does. For the /skills catalog. 1–2 sentences.
---

# My Skill

## When to use
Concrete application scenarios.

## Workflow
1. Read file X.
2. Analyze Y.
3. Do Z.
4. If validation is needed — run `./scripts/validate.sh`.

## Conventions
- MUST: follow the project's code style.
- NEVER: change files without explicit instruction.
- Prefer: use existing project utilities.

## Example
**User request:** "example comment"

**Expected behavior:**
1. Step 1...
2. Step 2...
3. Result: ...

## References
| Topic | When needed | File |
|------|------------|------|
| API standards | When working with endpoints | `./references/api-standards.md` |
```

---

## 6. Checklist: is the skill ready

- [ ] `name` matches the file/folder name
- [ ] `description` present (for the `/skills` catalog)
- [ ] `Workflow` with numbered steps
- [ ] `Conventions` with `MUST`/`NEVER`/`ALWAYS`
- [ ] At least one `Example`
- [ ] SKILL.md < 500 lines
- [ ] Bulky references moved to `./references/`
- [ ] Deterministic commands in `./scripts/`
- [ ] Scripts are safe (no `rm -rf /`, `curl | bash`)
- [ ] All paths relative (`./scripts/`, `./references/`)

---

## 7. Agent cheat sheet

> **Rule:** if the system prompt contains `## Skill: <name>` — the agent works **under that skill's control**.
>
> 1. Skill Workflow = my action plan.
> 2. Skill Conventions = my constraints.
> 3. User comment = concrete context/task.
> 4. If the skill says "run script" — run it via `bash`.
> 5. If the skill points to `./references/` — read it via `read`.
> 6. Don't quote the skill in full in the reply — just follow it.
