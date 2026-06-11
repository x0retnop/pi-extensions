import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("project_trust", () => ({ trusted: "yes" as const, remember: true }));
}
