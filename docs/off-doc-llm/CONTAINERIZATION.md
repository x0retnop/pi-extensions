# Containerization

> Isolating Pi or its tool execution.

---

## Options

| Pattern | Isolates | Best for |
|---------|----------|----------|
| Gondolin extension | Built-in tools + `!` commands | Local micro-VM, auth on host |
| Plain Docker | Whole Pi process | Simple local isolation |
| OpenShell | Whole Pi process | Managed sandbox (local/remote) |

---

## Gondolin (micro-VM)

Requirements: Node.js ≥ 23.6.0, QEMU.

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
pi -e ~/.pi/agent/extensions/gondolin
```

- Mounts host cwd at `/workspace` in VM
- Overrides: read, write, edit, bash, grep, find, ls
- User `!` commands routed into VM
- File changes under `/workspace` write through to host

---

## Plain Docker

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y bash ca-certificates git ripgrep
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
WORKDIR /workspace
ENTRYPOINT ["pi"]
```

```bash
docker build -f Dockerfile.pi -t pi-sandbox .
docker run -it --rm \
  -v "$PWD:/workspace" \
  -e ANTHROPIC_API_KEY \
  pi-sandbox
```

---

## OpenShell

Requires an OpenShell gateway. Routes tool execution through policy-controlled sandbox.

---

## General guidance

- Run whole Pi in container/VM for full isolation
- Or use Gondolin for tool-level isolation with host auth
- Bind-mount: writes from container can modify host files
- Use read-only mounts or copy files in/out for stronger protection
- Don't mount `~/.pi/agent` unless container should access host sessions/credentials
