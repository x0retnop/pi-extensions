# Browser debug guide

Use `browser_debug` to inspect console output, capture traces, inspect React, and measure vitals.

## Console and errors

```text
browser_debug action:console
browser_debug action:errors
browser_debug action:console clear:true
```

Run `console`/`errors` after each page-changing action to catch frontend issues early.

## CDP URL helper

```text
browser_debug action:cdp_url
```

Returns the WebSocket CDP endpoint. The tools themselves need the HTTP URL:
`cdp_url:"http://127.0.0.1:9222/"`.

## Traces

```text
browser_debug action:trace_start
# ... reproduce the issue ...
browser_debug action:trace_stop output_path:./trace.json
```

## React

React introspection requires the React DevTools hook. Open the page with:

```text
browser action:open url:http://localhost:3000 extra_args:["--enable","react-devtools"]
browser_debug action:react_tree
browser_debug action:react_inspect fiber_id:42
```

Without `--enable react-devtools`, the `react_*` actions error.

## Vitals

```text
browser_debug action:vitals
browser_debug action:vitals url:https://example.com
```

## Tips

- Use `cdp_url` to debug your own Chrome.
- `vitals` and `cdp_url` work on any site regardless of framework.
