# Pi Coding Agent — Network Runtime Guide

Agent reference for diagnosing and fixing Pi's network behavior on this PC. Use this when the user complains that Pi cannot reach a provider, times out behind a VPN, fails package installs, or behaves differently depending on proxy/split-tunnel settings.

## What Pi runtime actually is

- Pi CLI is a **Node.js application** installed globally through npm.
- Entry shim: `C:\Users\user\AppData\Roaming\npm\pi`
- Real script: `C:\Users\user\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`
- Runtime process name: **`node.exe`**
- Config / state directory: `C:\Users\user\.pi\agent\` (`~/.pi/agent` in Git Bash)
- Version as of this writing: `0.79.10`

Everything that leaves the machine (LLM calls, update checks, npm installs) goes through the single `node.exe` process and the child processes it spawns.

## Network flows

| Flow | Process | Destination | Port | Purpose |
|---|---|---|---|---|
| **LLM inference (current default)** | `node.exe` | `https://opencode.ai/zen/go/v1` | 443 | `opencode-go` provider, OpenAI-compatible chat completions. Current default model `kimi-k2.7-code` uses this endpoint. |
| **LLM inference (Kimi provider)** | `node.exe` | `https://api.kimi.com/coding/v1` (OpenAI) or `https://api.kimi.com/coding` (Anthropic) | 443 | `kimi-coding` provider from the installed `pi-provider-kimi-code` package. |
| **Version check** | `node.exe` | `https://pi.dev/api/latest-version` | 443 | Startup "is there a new Pi version?" request. |
| **Install/update telemetry** | `node.exe` | `https://pi.dev/api/report-install` | 443 | Anonymous version ping after install/update. Disabled here via `enableInstallTelemetry: false`. |
| **Package install/update** | `npm` (child of `node.exe`) | `https://registry.npmjs.org/` and git hosts (`github.com`, `raw.githubusercontent.com`, etc.) | 443 | Installing or updating Pi packages (`pi install`, `pi update`). |
| **OAuth / login** | `node.exe` + browser | `https://auth.kimi.com` for Kimi; provider-specific for OpenCode | 443 | `/login` flow may open the browser and callback to a local port. |
| **Web search / fetch / project memory / session memory** | `node.exe` | `http://127.0.0.1:8000` | 8000 | Local 0x010 MCP gateway. Not internet traffic. |
| **Session embeddings** | `node.exe` | `http://127.0.0.1:8088` | 8088 | Local `llama-server` embedding endpoint. Not internet traffic. |

## How Pi handles proxies

Pi uses the `undici` HTTP client with `EnvHttpProxyAgent`. In practice:

- It reads `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` from the environment.
- If `settings.json` contains `"httpProxy": "http://..."`, Pi sets:
  ```js
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
  ```
  The `??=` means **already-set environment variables win** over `settings.json`.

So an agent configuring a system/VPN proxy has two options:

1. Set `HTTP_PROXY`/`HTTPS_PROXY` globally or in the shell before launching Pi.
2. Write `"httpProxy": "http://..."` into `~/.pi/agent/settings.json`.

### npm is separate

Pi calls `npm` as a child process for package operations. `npm` inherits environment variables, but it also honors its own `.npmrc` settings (`proxy`, `https-proxy`, `registry`). If a proxy is required, configure both the env vars and `.npmrc` to be safe.

## VPN / split-tunnel / TLS inspection notes

- `node.exe` is just a normal Windows process. If the VPN uses split tunneling, ensure `node.exe` (and child `npm`, `git`, `pythonw`, `llama-server`) are routed through the VPN interface.
- DNS resolution is delegated to the Windows resolver. Verify that `opencode.ai`, `pi.dev`, `registry.npmjs.org`, and (if used) `api.kimi.com` resolve to IPs reachable through the VPN.
- If a firewall or proxy performs TLS inspection, the root CA must be in the **Windows certificate trust store**. Node on Windows uses the system store (schannel), not a custom CA bundle by default.

## Environment variables that affect network behavior

| Variable | Effect |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Standard proxy variables read by Pi's HTTP client. |
| `PI_OFFLINE=1` | Disables all startup network operations (version check, package checks, telemetry). Does **not** disable LLM inference. |
| `PI_SKIP_VERSION_CHECK=1` | Skips only the `pi.dev/api/latest-version` call. |
| `PI_TELEMETRY=0` | Disables install/update telemetry and provider attribution headers. |
| `OPENCODE_API_KEY` | API key for `opencode` / `opencode-go`. Also readable from `~/.pi/agent/auth.json`. |
| `KIMI_API_KEY` | API key for the Kimi provider. Also readable from `~/.pi/agent/auth.json`. |
| `PI_CODING_AGENT_DIR` | Override config directory. |
| `PI_WEB_SEARCH_URL` | Override the 0x010 backend base URL (default `http://127.0.0.1:8000`). |
| `PI_WEB_SEARCH_MCP_PATH` | Override the 0x010 MCP mount path (default `/mcp`). |

## Diagnostic commands

```bash
# What proxy does Pi think it should use?
cat ~/.pi/agent/settings.json | jq '.httpProxy'

# What proxy is active in the current shell?
env | grep -i proxy

# Is the default LLM endpoint reachable?
curl -I -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $OPENCODE_API_KEY" \
  https://opencode.ai/zen/go/v1/models

# Is pi.dev reachable?
curl -I -s -o /dev/null -w "%{http_code}" https://pi.dev/api/latest-version

# Is npm registry reachable?
curl -I -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/

# DNS resolution
nslookup opencode.ai
nslookup pi.dev
nslookup registry.npmjs.org

# TCP connectivity from PowerShell
pwsh -Command "Test-NetConnection opencode.ai -Port 443"
pwsh -Command "Test-NetConnection pi.dev -Port 443"
pwsh -Command "Test-NetConnection registry.npmjs.org -Port 443"

# Local backends (should be LISTENING on 127.0.0.1)
netstat -ano | grep -E '8000|8088'
```

## Logs and state files

| File | Why look there |
|---|---|
| `~/.pi/agent/settings.json` | `httpProxy`, default provider/model, telemetry flags. |
| `~/.pi/agent/auth.json` | Stored API keys and OAuth tokens. |
| `~/.pi/agent/models.json` | Custom provider definitions and endpoint overrides. |
| `~/.pi/agent/logs/` | Runtime logs. |
| `~/.pi/agent/pi-crash.log` | Crash backtraces, often contain the last failed network call. |

## Current configuration snapshot

- **Default provider:** `opencode-go`
- **Default model:** `kimi-k2.7-code`
- **Endpoint for current default:** `https://opencode.ai/zen/go/v1`
- **Auth variable:** `OPENCODE_API_KEY`
- **Installed custom provider package:** `npm:pi-provider-kimi-code` (provider id `kimi-coding`, endpoint `https://api.kimi.com/coding/v1`)
- **Local backends:** 0x010 MCP gateway on `127.0.0.1:8000`, embedding server on `127.0.0.1:8088`

## See also

- `docs/pi-providers-models.md` — how providers/models are loaded and how to add custom endpoints.
- `docs/pi-local-map.md` — where Pi's compiled source lives on disk.
- `docs/0x010-control.md` — starting/stopping the local 0x010 backend.
- `~/.pi/agent/settings.json` — live global settings (read-only unless the user asks you to edit it).
