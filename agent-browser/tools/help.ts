import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const Topics = StringEnum(
  ["map", "web_automation", "network", "state", "debug"],
  { description: "Help topic" },
);

function getSkillPath(topic: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "skills", `${topic}.md`);
}

export const helpToolDefinition = {
  name: "browser_help",
  label: "Browser Help",
  description:
    "Return skill guidance for agent-browser tools. Use when you need a reminder of " +
    "which browser tool to use or how to perform a browser workflow.",
  parameters: Type.Object({
    topic: Type.Optional(Topics),
  }),

  async execute(
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ) {
    const topic = String(params.topic ?? "map");
    const valid = ["map", "web_automation", "network", "state", "debug"];
    const safeTopic = valid.includes(topic) ? topic : "map";

    try {
      const text = readFileSync(getSkillPath(safeTopic), "utf-8");
      return {
        content: [{ type: "text" as const, text }],
        details: { topic: safeTopic } as { topic: string },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error loading help: ${message}` }],
        details: { topic: safeTopic, error: message },
      };
    }
  },
};
