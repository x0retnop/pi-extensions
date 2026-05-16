# Pi Kimi

Minimal Kimi For Coding provider for Pi. Adds `kimi-for-coding` to `/login` via OAuth device flow.

## Install

```bash
pi install ./pi-kimi
```

## Usage

```bash
/login
```
 -> Use a subscription -> Kimi For Coding > copy link

Follow the device authorization link. Credentials are stored by Pi in `auth.json`.

## Model

| ID | Context | Max tokens | Reasoning | Input |
|---|---|---|---|---|
| `kimi-for-coding` | 262k | 32k | yes | text, image |

## What it does

- Registers `kimi-for-coding` provider with `pi.registerProvider()`.
- OAuth device flow against `auth.kimi.com`.
- Attaches Kimi CLI device headers (`X-Msh-Device-Id`, `X-Msh-Platform`, etc.) to every request.
- Uses Pi's built-in `openai-completions` streaming — no custom `streamSimple` or global `fetch` patches.

## Compatibility

Tested with Pi v0.74.0 or newer.
