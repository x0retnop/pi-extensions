import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCursorToolShims } from "./cursor-shims";
import { registerCustomXaiTools } from "./custom-tools";

const xaiToolRegistrations = new WeakSet<object>();

/** Register all xAI tools once per pi API object. */
export function registerXaiTools(pi: ExtensionAPI) {
  if (xaiToolRegistrations.has(pi as object)) return;
  xaiToolRegistrations.add(pi as object);

  registerCursorToolShims(pi);
  registerCustomXaiTools(pi);
}
