# Prompt Templates

> Markdown snippets that expand from slash commands.
> Type `/name` to invoke (filename without `.md`).

---

## Locations

| Path | Scope |
|------|-------|
| `~/.pi/agent/prompts/*.md` | Global |
| `.pi/prompts/*.md` | Project (trusted) |
| Package `prompts/` dir or `pi.prompts` in package.json | Packages |
| Settings `prompts` array | Settings |
| `--prompt-template <path>` | CLI |

Disable: `--no-prompt-templates`.

---

## Format

```markdown
---
description: Review staged git changes
argument-hint: "<PR-URL>"
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- Frontmatter: `description` (shown in autocomplete), `argument-hint` (optional, shows expected args)
- Filename = command name: `review.md` → `/review`
- If no `description`, first non-empty line is used

---

## Usage

- Type `/name` in editor
- Autocomplete shows available templates
- Template text is inserted at cursor position
- `/reload` after adding templates
