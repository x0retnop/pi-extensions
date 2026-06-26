# Browser integration — current findings

## Goal

Let the Pi agent use the user's Chrome with an active profile so automation starts with cookies, logins, and history already in place.

## Verified facts

### 1. Chrome 149 on Windows blocks remote debugging on the default user-data dir

Chrome checks `IsUsingDefaultDataDirectory()`. If `--user-data-dir` points to the default location:

```
%LOCALAPPDATA%\Google\Chrome\User Data
```

`--remote-debugging-port` is silently ignored.

Tested and confirmed:
- A separate profile (`main` / `Profile 1`) inside the default `User Data` dir is **not enough**.
- `--disable-features=DevToolsDebuggingRestrictions` does **not** work on Google Chrome branded builds.
- `chrome://inspect/#remote-debugging` approval mode works only with manual UI approval per connection — not usable by an unattended agent.

### 2. Copying a profile to a non-default path breaks logins/cookies

Chrome 127+ on Windows uses **App-Bound Encryption (ABE)** for cookies and saved passwords. The encryption is bound to:

- the Windows user account (DPAPI)
- the path of `chrome.exe`
- the user-data directory path
- system DPAPI/CNG keys

Copying `Default` or any profile folder to `C:\chrome-main` makes Chrome treat the encrypted data as invalid and reset it. Bookmarks copy fine, but cookies and logins are lost.

### 3. What works: a non-default user-data-dir created from scratch

If Chrome starts with a non-default `--user-data-dir`, it accepts `--remote-debugging-port` and `agent-browser` can attach.

User launchers now live in `C:\chrome-main`:

- `Start Chrome Agent.bat`
- `Start Chrome Agent.ps1`
- `Start Chrome Agent.lnk` (desktop shortcut)

Command:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="C:\chrome-main" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=*
```

Then attach `agent-browser`:

```bash
agent-browser connect http://127.0.0.1:9222/
agent-browser snapshot -i
```

> Note: `agent-browser --cdp <url>` does **not** attach to an already-running Chrome. Use `agent-browser connect <url>` first.

Verified working after first `connect`:

- `snapshot` / `snapshot -i`
- `open`, `get url`, `get title`
- `fill`, `click`, `type`
- `eval`
- `cookies get`
- network requests

## Workflow for the user

1. Launch Chrome via `C:\chrome-main\Start Chrome Agent`.
2. Use Chrome normally: log into sites, keep tabs open, build up the profile.
3. The agent connects to the already-running browser at `http://127.0.0.1:9222/`.
4. Do **not** close or restart Chrome while the agent is using it.

This is the clean way to keep cookies/logins while allowing remote debugging.

## How the Pi extension uses it

The extension exposes a `cdp_url` parameter on every browser tool. When it is provided, the extension runs `agent-browser connect <cdp_url>` before the action.

Example tool call:

```text
browser action:open url:https://grok.com cdp_url:http://127.0.0.1:9222/
```

## Alternative

If the user does not want to maintain a separate Chrome profile, they can let `agent-browser` use its own bundled Chromium. The agent gets a clean browser every time and must log in manually when needed.

## Recommendation

- Keep the separate-profile + CDP approach.
- Add `cdp_url` to the extension and auto-run `agent-browser connect` before actions when it is provided.
- Update README and `docs/extensions/agent-browser.md` with the launcher workflow.
