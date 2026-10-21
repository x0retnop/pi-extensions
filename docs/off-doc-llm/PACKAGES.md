# Pi Packages

> Bundle and share extensions, skills, prompt templates, themes.
> Sources: npm, git, URL, local path.

---

## Install & manage

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list

pi update                    # pi only
pi update --all              # pi + packages + git refs
pi update --extensions       # packages only
pi update npm:@foo/bar       # single package
```

| Flag | Effect |
|------|--------|
| `-l` | Install to project `.pi/settings.json` instead of global |
| `-e` | Temporary (current run only, temp directory) |

---

## Sources

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs pinned, skipped by `pi update --extensions`
- User: `~/.pi/agent/npm/`
- Project: `.pi/npm/`
- Custom npm command: `{ "npmCommand": ["mise", "exec", "node@20", "--", "npm"] }`

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
```

- Tags, branches, commits as version
- `pi update` reconciles pinned git refs
- Cloned to `~/.pi/agent/git/` or `.pi/git/`

---

## Package structure

```
my-package/
  package.json        # "pi" key declares resources
  extensions/         # *.ts or */index.ts
  skills/             # *.md or */SKILL.md
  prompts/            # *.md
  themes/             # *.json
```

Or declare in `package.json`:

```json
{
  "name": "my-package",
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./workflows"],
    "prompts": ["./templates"],
    "themes": ["./colors"]
  }
}
```

---

## Package filtering

Selectively enable/disable resources:

```json
{
  "packages": ["npm:@foo/bar"],
  "extensions": ["npm:@foo/bar/some-tool"],
  "settings": {
    "pi": {
      "packages": {
        "npm:@foo/bar": {
          "extensions": false,        // Disable all extensions from this package
          "skills": ["build"],        // Only "build" skill
          "prompts": true              // All prompts
        }
      }
    }
  }
}
```

---

## Dependencies

- Runtime deps in `dependencies` (production install: `npm install --omit=dev`)
- git packages use plain `install` when `npmCommand` is configured
- Node built-ins always available

---

## Create a package

1. Create directory with `package.json` + resources
2. Declare in `pi` key or use conventional directories
3. Test with `pi -e ./path/to/package`
4. Publish to npm or push to git
