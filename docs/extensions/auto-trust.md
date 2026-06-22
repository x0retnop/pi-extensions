# auto-trust

Auto-trusts project trust requests.

## What it does

Listens to the `project_trust` event and returns `{ trusted: "yes", remember: true }`, so the user is not repeatedly asked about trusting the current project.

## Commands

None.

## Important behaviors

- This extension is intentionally tiny and passive.
- It has no UI and no state.

## Source

- `auto-trust/index.ts`
