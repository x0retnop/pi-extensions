# Network

`browser_network` tool actions.

## Actions

- `route pattern:<glob> body:<json>` — mock a response.
- `route pattern:<glob> abort:true` — block requests.
- `route pattern:<glob> resource_type:<csv>` — limit to resource types.
- `unroute pattern:<glob>` — remove route.
- `requests` — list captured requests.
- `requests pattern:<glob>` — filter requests.
- `har_start` — start HAR recording.
- `har_stop output_path:<path>` — stop and save HAR.

## Workflow

1. `browser_network action:route pattern:"**/api/users" body:'{"users":[]}'`
2. Load or interact with the page.
3. `browser_network action:requests` to inspect traffic.
4. `browser_network action:har_stop output_path:./trace.har`

Set routes before opening/navigating so they apply to initial requests.
