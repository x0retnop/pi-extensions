# State

`browser_state` tool actions.

## Actions

- `cookies` — get cookies.
- `cookies_set name:<name> value:<value> domain:<domain> path:<path>` — set cookie.
- `cookies_clear` — clear cookies.
- `storage_local key:<key>` — read localStorage key.
- `storage_session key:<key>` — read sessionStorage key.
- `state_save path:<path>` — save cookies + storage to JSON.
- `state_load path:<path>` — load saved state.

## Auth workflow

1. Log in manually or via `browser` tool.
2. `browser_state action:state_save path:./auth.json`
3. Next session: `browser_state action:state_load path:./auth.json`

Or pass `extra_args:["--session-name", "my-app"]` to auto-save/restore state.
