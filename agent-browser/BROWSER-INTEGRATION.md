# Browser integration — current findings

## Goal

Let the Pi agent use the user's Chrome with an active profile so automation starts with cookies, logins, and history already in place.

## What we learned

### 1. Chrome 136+/147+ blocks remote debugging on the default profile path

On Windows, Chrome checks `IsUsingDefaultDataDirectory()`. If `--user-data-dir` points to the default location:

```
%LOCALAPPDATA%\Google\Chrome\User Data
```

then `--remote-debugging-port` is silently ignored. This happens even if you specify `--profile-directory=Profile 1` or any other profile name.

### 2. Copying the profile to a non-default path breaks logins/cookies

Chrome 127+ on Windows uses **App-Bound Encryption (ABE)** for cookies and saved passwords. The encryption is bound to:

- the Windows user account (DPAPI)
- the path of `chrome.exe`
- the user-data directory path
- system DPAPI/CNG keys

Copying `Default` or any profile folder to `C:\chrome-main` makes Chrome treat the encrypted data as invalid and reset it. Bookmarks copy fine, but cookies and logins are lost.

### 3. What works: separate user-data-dir with a fresh profile

If you create a profile in a non-default user-data-dir, Chrome accepts `--remote-debugging-port` and `agent-browser` can connect.

Example launch:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="C:\chrome-main" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=*
```

Then `agent-browser` connects with:

```bash
agent-browser --cdp http://127.0.0.1:9222/ snapshot -i
```

Verified working:

- snapshot / snapshot -i
- get url / get title
- fill / click / type
- eval
- cookies get
- network requests

### 4. The chosen user workflow

Because copying the old profile failed, the user will build up the new `C:\chrome-main` profile from scratch:

1. Launch Chrome with `--user-data-dir=C:\chrome-main`.
2. Log into sites manually in that Chrome window.
3. The agent then connects via CDP and reuses that session.

This is the only clean way to keep cookies/logins while allowing remote debugging.

## How the agent should use it

Once the extension is updated with a `cdp_url` parameter, the agent will be able to call:

```text
browser action:open url:https://grok.com cdp_url:http://127.0.0.1:9222/
```

Until then, the user can pass it via `extra_args`:

```text
browser action:open url:https://grok.com extra_args:["--cdp", "http://127.0.0.1:9222/"]
```

## Alternative

If the user does not want to maintain a separate Chrome profile, they can let `agent-browser` use its own bundled Chromium. The agent gets a clean browser every time and must log in manually when needed.

## Recommendation

- Proceed with the separate-profile + CDP approach.
- Add `cdp_url` to the extension to make the workflow natural for the agent.
- Document the Chrome launch command in the extension README.
