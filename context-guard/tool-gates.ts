import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolGate } from "./types.js";

export const TOOL_GATES: ToolGate[] = [
  {
    id: "sessionMemory",
    label: "Session memory",
    description: "Semantic search across past sessions (session_memory tool).",
    defaultEnabled: true,
    toolsOn: ["session_memory"],
    toolsOff: [],
  },
  // Reserved for future use after pi-web-access refactor:
  // {
  //   id: "webAccess",
  //   label: "Web access",
  //   description: "Web search, fetch, and code search tools.",
  //   defaultEnabled: false,
  //   toolsOn: ["web_search", "code_search", "fetch_content"],
  //   toolsOff: ["web_access"],
  // },
];

export function getToolGateDefaults(): Record<string, boolean> {
  return Object.fromEntries(TOOL_GATES.map((g) => [g.id, g.defaultEnabled]));
}

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
