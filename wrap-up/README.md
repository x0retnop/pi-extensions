# Wrap-up Skill

End any session cleanly. One command, two outcomes.

## Install

```bash
mkdir -p ~/.pi/agent/skills/wrap-up
cp -r wrap-up ~/.pi/agent/skills/
```

## Usage

```text
/skill:wrap-up
```

## Behavior

Auto-detects whether work is finished:

- **Done** → updates project docs, suggests commit, lists files to clean up.
- **Not done** → updates context and prepares a compact handoff prompt for `/new`.

No auto-commit, no auto-delete. User decides.
