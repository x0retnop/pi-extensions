# Skills

> Self-contained capability packages (Agent Skills standard).
> Progressive disclosure: only name/description in system prompt, full `.md` loaded on demand via `/skill:name` or `read`.

---

## Locations

| Path | Scope |
|------|-------|
| `~/.pi/agent/skills/` | Global |
| `~/.agents/skills/` | Global |
| `.pi/skills/` | Project (trusted) |
| `.agents/skills/` in cwd + ancestors | Project (up to git root) |
| Package `skills/` dir or `pi.skills` in package.json | Packages |
| `settings.json` → `skills` array | Settings |
| `--skill <path>` | CLI |

Disable discovery: `--no-skills` (explicit `--skill` still works).

### Discovery rules

- `~/.pi/agent/skills/` and `.pi/skills/`: direct `.md` files are individual skills
- All skill locations: directories containing `SKILL.md` are discovered recursively
- `~/.agents/skills/` and `.agents/skills/`: root `.md` files are ignored (only `SKILL.md` in dirs)

### Cross-harness skills

```json
{ "skills": ["~/.claude/skills", "~/.codex/skills"] }
```

---

## Skill format

```markdown
---
name: skill-name
description: What this skill does
---
# Skill Name

Instructions, setup, scripts reference.
```

- Frontmatter: `name` (required), `description` (required for discovery)
- Body: markdown with instructions the agent should follow
- Relative paths reference scripts/assets in the skill directory

---

## Commands

| Command | Effect |
|---------|--------|
| `/skill:name` | Load and execute skill |
| `/skill:name arg1 arg2` | With arguments |
| `/reload` | Reload after adding skills |

---

## What skills contain

Typically: workflow instructions, setup steps, helper scripts, reference docs for specific tasks (testing, deployment, linting, etc.).
