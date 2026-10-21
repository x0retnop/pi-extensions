# TUI Components

> Custom terminal UI for extensions, via `ctx.ui.custom()`.
> Source: `@earendil-works/pi-tui`.

---

## Component interface

```typescript
interface Component {
  render(width: number): string[];       // Return lines, each ≤ width
  handleInput?(data: string): void;      // Keyboard input when focused
  wantsKeyRelease?: boolean;             // Receive key release events (Kitty)
  invalidate(): void;                    // Clear cached render (theme change)
}
```

**Render rules:**
- TUI appends SGR reset + OSC 8 reset after each line
- Styles don't carry across lines — reapply per line
- Use `wrapTextWithAnsi()` for multi-line styled text

---

## Focusable interface (IME support)

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI

  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

When `Focusable` has focus:
1. TUI sets `focused = true`
2. Scans output for `CURSOR_MARKER` (zero-width APC)
3. Positions hardware cursor there
4. Shows hardware cursor only if `showHardwareCursor` enabled

Container components with embedded inputs must propagate `Focusable`.

---

## Using custom components in extensions

```typescript
// ctx.ui.custom(component, options?)
await ctx.ui.custom(myComponent, {
  border: true,
  title: "My Component",
});
```

The method returns when the component signals completion (via callback or external event).

---

## Editor & Input components

Built-in components (from `@earendil-works/pi-tui`):
- `Editor` — multi-line text editor with syntax highlighting
- `Input` — single-line input
- Both implement `Component` and `Focusable`

---

## Container patterns

```typescript
class MyDialog implements Component, Focusable {
  focused: boolean = false;
  private input = new Input();

  handleInput(data: string) {
    if (this.focused) this.input.handleInput(data);
  }

  render(width: number): string[] {
    const inputLines = this.input.render(width);
    return [
      `┌──────────────┐`,
      ...inputLines.map(l => `│ ${l.padEnd(width-4)} │`),
      `└──────────────┘`,
    ];
  }
}
```

---

## Key considerations

- **No async render**: `render()` must be synchronous
- **No exceptions in render**: catch and display errors gracefully
- **Incremental rendering**: keep render fast; use `invalidate()` sparingly
- **Width constraint**: each line MUST NOT exceed `width` parameter
- **ANSI styling**: use `\x1b[...m` codes, reapply per line
