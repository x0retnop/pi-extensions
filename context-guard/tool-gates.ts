import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolGate } from "./types.js";

export const TOOL_GATES: ToolGate[] = [
  {
    id: "bash",
    label: "bash",
    description: "Built-in bash shell execution tool.",
    defaultEnabled: true,
    toolsOn: ["bash"],
    toolsOff: [],
  },
  // sessionMemory gate removed with the pi-session-memory backend (2026-09-20).
];

export function syncToolGates(pi: ExtensionAPI, features: Record<string, boolean>): void {
  const active = new Set(pi.getActiveTools());

  // Remove all tools managed by context-guard so we can re-apply desired state cleanly.
  for (const gate of TOOL_GATES) {
    for (const t of [...(gate.toolsOn ?? []), ...(gate.toolsOff ?? [])]) {
      active.delete(t);
    }
  }

  // Apply desired state.
  for (const gate of TOOL_GATES) {
    const enabled = features[gate.id] ?? gate.defaultEnabled;
    const list = enabled ? gate.toolsOn ?? [] : gate.toolsOff ?? [];
    for (const t of list) active.add(t);
  }

  pi.setActiveTools([...active]);
}
