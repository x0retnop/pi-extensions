> **Experimental** — internal type-safety and provider-detection improvements are deferred.

# Temperature / Model Utility

Adds `/tm` to set LLM temperature at runtime, plus automatic temperature injection before provider requests. Also detects Kimi provider and strips unsupported sampling parameters.

## Install

```bash
pi install ./tm
```

## Commands

| Command | Description |
| --- | --- |
| `/tm` | Show the current temperature and detected provider. |
| `/tm 0.7` | Set temperature to `0.7` for the session. |

## Behavior

- Reads the default temperature from `~/.pi/agent/models.json` on session start and model switch.
- Injects `temperature` into the provider payload for supported APIs (`anthropic-messages`, `openai-completions`, `openai-responses`).
- Detects Kimi provider (`anthropic-messages` + `kimi.com` base URL) and removes `temperature`, `top_p`, `presence_penalty`, and `frequency_penalty` because Kimi uses fixed sampling parameters.
- Shows a status indicator when `ctx.ui.setStatus` is available.

## Settings

No external settings file. Configure default temperatures in `~/.pi/agent/models.json` per provider.

## Compatibility

Tested and known to work with Pi v0.72.1 or newer.

## Maintenance

See [`AGENTS.md`](../AGENTS.md) for open tasks.
