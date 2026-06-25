# Debug

`browser_debug` tool actions.

## Actions

- `console` — read console messages.
- `errors` — read page errors.
- `trace_start` — start Chrome DevTools trace.
- `trace_stop output_path:<path>` — stop and save trace.
- `react_tree` — print React component tree (needs `--enable react-devtools`).
- `react_inspect fiber_id:<id>` — inspect one fiber.
- `vitals url:<url>` — measure Core Web Vitals.

## Workflow

1. Reproduce the issue.
2. `browser_debug action:console` and `browser_debug action:errors`.
3. `browser_debug action:trace_start` → interact → `browser_debug action:trace_stop output_path:./trace.json`.

React commands require opening the page with `extra_args:["--enable", "react-devtools"]`.
