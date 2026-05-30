# pi-skill-guard

Control which skills reach the LLM. Disable automatic skill injection globally, or manually inject a specific skill on demand.

## Install

Copy `pi-skill-guard` to `~/.pi/agent/extensions/` and restart Pi.

## Usage

- `/skills` — Show auto-skill status and loaded skills.
- `/skills-toggle` — Turn automatic skill injection ON / OFF (persisted in `settings.json`).
- `/use-skill` — Open an interactive picker, choose a skill, and it is pasted into the editor as `/use-skill <name> `. Add an optional comment and send.
- `/use-skill <name> [comment]` — Inject the skill directly. If a comment is provided it is sent as the user message; otherwise a placeholder message is used to trigger the turn.

When auto-skills are OFF, the `<available_skills>` block is stripped from the system prompt before every LLM call. `/use-skill` still works because it reads the skill file directly.
