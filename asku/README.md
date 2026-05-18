# asku

Interactive `ask_user_question` tool for Pi.

This is a compact adaptation of [`ghoseb/pi-askuserquestion`](https://github.com/ghoseb/pi-askuserquestion) for this extensions collection: same idea, smaller package shape, Pi `@earendil-works/*` imports, and minimal local docs.

## What it does

Lets the agent ask 1–4 structured clarifying questions in the TUI instead of asking in plain text. Supports:

- **Choice mode:** 2-4 options per question (single or multi-select).
- **Open mode:** free-text question with no fixed options (name, path, confirmation).
- custom free-text answer inside choice mode via built-in "Other";
- multi-question tab view;
- cancel via `Esc`.

## Install

From this repo:

```bash
pi install ./asku
```

## Tool

The extension registers `ask_user_question` automatically.

The model sends questions with short headers and 2–4 options. The user's answers are returned to the model as text plus structured `details`.
