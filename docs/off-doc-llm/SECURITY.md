# Security

> Pi runs with user permissions. No built-in sandbox.
> Project trust = input-loading guard, not security boundary.

---

## Project trust

| Aspect | Detail |
|--------|--------|
| Purpose | Prevents repo from silently changing settings/extensions |
| Not | A sandbox — does not restrict model actions |
| Trigger | `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, `.agents/skills` |
| Default | `"ask"` (interactive), `"never"` (non-interactive) |
| Global override | `defaultProjectTrust` in `~/.pi/agent/settings.json` |
| CLI override | `--approve` / `-a` or `--no-approve` / `-na` |
| Save decision | `/trust` in interactive mode |

### Trusted resources

On trust: `.pi/settings.json`, `.pi` extensions/skills/prompts/themes, project packages, project extensions.

Without trust: skipped. `AGENTS.md` / `CLAUDE.md` still load.

### Trust in non-interactive modes

| `defaultProjectTrust` | Behavior |
|-----------------------|----------|
| `"ask"` (default) | Ignore project resources |
| `"always"` | Trust |
| `"never"` | Ignore |

---

## No built-in sandbox

- Built-in tools: read, write, edit, bash — full user permissions
- Extensions: full system access
- Shell commands, language servers, test commands — ordinary processes

### Running untrusted code

Options (see CONTAINERIZATION.md):

| Method | Isolates | Best for |
|--------|----------|----------|
| Gondolin extension | Built-in tools + `!` commands | Micro-VM, auth stays on host |
| Docker | Whole Pi process | Simple container boundary |
| OpenShell | Whole Pi process | Policy-controlled sandbox |

---

## Reporting

Report vulnerabilities to [SECURITY.md](https://github.com/earendil-works/pi-mono/blob/main/SECURITY.md) — not public issues.
