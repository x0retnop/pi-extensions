# Skill Checklist

Run through this list before saving a new or updated skill.

## Structure

- [ ] `name` matches folder name, lowercase-with-hyphens, max 64 chars
- [ ] `description` is present and clear (for `/skills` catalog)
- [ ] Body contains `## When to Use`
- [ ] Body contains `## Workflow` with numbered steps and imperative verbs
- [ ] Body contains `## Conventions` with MUST/NEVER/ALWAYS rules
- [ ] Body contains `## Example` with concrete input → output

## Size & Organization

- [ ] SKILL.md is under 500 lines (preferably under 400)
- [ ] Bulky reference material lives in `./references/`
- [ ] Deterministic commands live in `./scripts/`
- [ ] No duplication with Pi role or AGENTS.md

## Content Quality

- [ ] One skill, one verb (no mixing "review" and "generate")
- [ ] Example shows explicit values, not `<placeholder>` syntax
- [ ] All content is in English (body, file names, script comments)
- [ ] No platform-specific frontmatter (`type: flow`, `allowed-tools`, etc.)

## Safety

- [ ] Scripts do not contain `rm -rf /`, `curl | bash`, or secret exfiltration
- [ ] Destructive operations have a confirmation gate or explicit warning
- [ ] File write operations target expected paths only

## Paths

- [ ] All internal references use relative paths (`./scripts/`, `./references/`)
- [ ] External links are authoritative and stable
