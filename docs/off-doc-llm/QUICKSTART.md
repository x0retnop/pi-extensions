# Quickstart

> Install → authenticate → run.

---

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts.

### Uninstall

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

Leaves `~/.pi/agent/` (settings, credentials, sessions) intact.

---

## Authenticate

### Option 1: Subscription login

Run `pi`, then `/login` → select provider:
- Claude Pro/Max
- ChatGPT Plus/Pro (Codex)
- GitHub Copilot

### Option 2: API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

Or use `/login` → select API-key provider → paste key.

---

## First run

```bash
cd /path/to/project
pi
```

Pi asks to trust the project if it has `.pi/settings.json` or `.pi/extensions/` etc.
