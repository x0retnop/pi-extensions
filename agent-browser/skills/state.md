# Browser state guide

Use `browser_state` for cookies, web storage, and saved auth state.

## Cookies

```text
browser_state action:cookies
browser_state action:cookies_set name:session value:abc123 domain:example.com path:/
browser_state action:cookies_clear
```

## Web storage

```text
browser_state action:storage_local key:authToken
browser_state action:storage_session key:userId
```

To set or clear storage, use `browser action:eval`:

```text
browser action:eval text:"localStorage.setItem('authToken','abc123')"
browser action:eval text:"localStorage.removeItem('authToken')"
```

## Persist auth

```text
# after logging in
browser_state action:state_save path:./auth.json
# next run
browser_state action:state_load path:./auth.json
```

## Tips

- Save state before closing the browser.
- `cdp_url` works with state tools if you are attached to your own Chrome.
- State files contain plaintext session tokens — keep them out of git and delete when no longer needed.
