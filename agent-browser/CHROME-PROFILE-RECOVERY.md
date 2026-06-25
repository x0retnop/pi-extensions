# Chrome profile recovery notes

## What we were trying to do

Enable `agent-browser` to reuse the existing Chrome profile (cookies, logins, history) so that automation starts already logged in.

## What we did

1. Created a new Chrome profile named `main` inside the default user-data dir (`Profile 1`).
2. Copied `Default` profile data into `Profile 1`.
3. Discovered Chrome 136+/147+ on Windows blocks `--remote-debugging-port` when using the default user-data directory (`%LOCALAPPDATA%\Google\Chrome\User Data`).
4. Created a separate user-data dir: `C:\chrome-main`.
5. Copied `Profile 1` → `C:\chrome-main\Default`.
6. Created a desktop shortcut `Chrome Main` that launches:
   ```
   chrome.exe --user-data-dir="C:\chrome-main" --remote-debugging-port=9222 --remote-allow-origins=*
   ```
7. Verified that `agent-browser --cdp http://127.0.0.1:9222/` connects and can interact with the page.

## What broke

- Bookmarks copied fine.
- Cookies and saved logins did **not** carry over. After starting Chrome from `C:\chrome-main`, all sites were logged out.
- The original `Default` profile in `%LOCALAPPDATA%\Google\Chrome\User Data\Default` also lost cookies/logins after this process.
- A phantom empty profile `Profile` / "работа" kept reappearing in `Local State` because of the multi-profile mess.

## Why it broke

Chrome on Windows since version 127+ uses **App-Bound Encryption (ABE)** for cookies and passwords. The encryption is bound to:

- the Windows user account (DPAPI)
- the path of the `chrome.exe` process
- the user-data directory path
- system-level DPAPI/CNG keys

Copying the profile folder to a different path (`C:\chrome-main`) breaks the decryption chain, so Chrome treats the encrypted data as invalid and resets it. Even copying back to the original location may not restore decryption if `Local State` or the DPAPI key chain was touched.

## Current state

- `C:\chrome-main` exists with a 1.5 GB `Default` profile.
- The original `%LOCALAPPDATA%\Google\Chrome\User Data\Default` is also ~1.5 GB.
- User mentioned the original profile used to be **3–4 GB**, so some data may still be missing or in another location.

## What to check in a fresh session

1. **Where is the real backup?**
   - Find the backup the user made before this session.
   - Check its size and dates:
     - `Login Data`
     - `Network/Cookies`
     - `History`
     - `Web Data`
     - `Local State`
   - If the backup is ~3–4 GB and files are older than Jun 25 23:30, it likely contains the original cookies/logins.

2. **Is there another profile folder?**
   - Search `C:\` and `D:\` for `User Data` folders larger than 2 GB.
   - Check `%LOCALAPPDATA%\Google\Chrome\`, `%APPDATA%\Google\Chrome\`, and any custom paths.

3. **Restore procedure**
   1. Fully close Chrome (`taskkill /F /IM chrome.exe`).
   2. Rename current `%LOCALAPPDATA%\Google\Chrome\User Data` to `User Data.broken`.
   3. Copy the backup `User Data` folder into `%LOCALAPPDATA%\Google\Chrome\User Data`.
   4. Launch Chrome normally (no flags) and verify logins/cookies.

4. **Alternative for automation without losing logins**
   - Do **not** copy the profile to a new path.
   - Instead, either:
     - a) Use the original user-data dir and find a way to enable remote debugging despite Chrome 147+ restrictions.
     - b) Use a system-level approach (service, COM elevation) that Chrome's App-Bound Encryption accepts.
     - c) Accept that automation will need to log in manually once per new profile.

## Files created during this session

- `C:\chrome-main\` — copied profile dir
- `C:\Users\user\Desktop\Chrome Main.lnk` — shortcut with `--user-data-dir=C:\chrome-main`
- `C:\tmp\start-chrome-main.ps1` — PowerShell launcher
- `C:\tmp\copy-to-chrome-main.ps1` — copy script
- `C:\tmp\create-shortcut.ps1` — shortcut script

## Relevant docs

- Chrome blog: https://developer.chrome.com/blog/remote-debugging-port
- ABE tool reference: https://github.com/aabston/chrome-decrypt-offline
- Browser-use workaround PR: https://github.com/browser-use/browser-harness/pull/142

## Next step

Decide whether to:
1. Restore the original profile from the user's backup, or
2. Abandon the "reuse existing Chrome" path and instead use `agent-browser`'s own Chromium with manual login when needed.
