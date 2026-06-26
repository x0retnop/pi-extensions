# Browser network guide

Use `browser_network` to intercept, mock, block, or record traffic.

## Route and mock

```text
browser_network action:route pattern:"**/api/users" body:'{"users":[]}'
browser_network action:route pattern:"**/analytics" abort:true
browser_network action:route pattern:"*.png" abort:true resource_type:image
```

Set routes **before** opening/navigating the page to affect initial requests.

## Inspect traffic

```text
browser_network action:requests
browser_network action:requests pattern:"**/api/**"
browser_network action:requests clear:true
```

## HAR recording

```text
browser_network action:har_start
# ... interact ...
browser_network action:har_stop output_path:./trace.har
```

## Tips

- `pattern` uses glob syntax (`**`, `*`).
- `resource_type` is a comma-separated list (xhr, fetch, document, script, image, etc.).
- Use `cdp_url` to attach to your own Chrome.
- Without a `pattern`, `route` matches all requests; be careful not to break the page.
