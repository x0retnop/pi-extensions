/**
 * Toggle Pi's built-in Working... loader row.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** working=true → show row; working=false → hide. */
export function applyWorkingVisible(ctx: ExtensionContext | null, working: boolean): void {
  try {
    if (!ctx?.hasUI) return;
    (ctx.ui as any).setWorkingVisible?.(working);
  } catch {
    // ignore
  }
}
