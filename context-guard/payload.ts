/**
 * Provider payload helpers: locate and rewrite the system prompt inside the
 * raw request payload. Used by:
 * - dump.ts     — read the FINAL prompt actually sent to the provider.
 * - index.ts    — enforce guard rules at payload level (after ALL extensions,
 *   including role-sw, have mutated the prompt), so toggles match the wire.
 *
 * Shapes Pi actually emits (see pi-ai dist/api):
 * - `system`              Anthropic Messages, Bedrock Converse
 * - `messages[]`          OpenAI Completions, Mistral (role system|developer)
 * - `input[]`             OpenAI Responses / Azure / Grok (role system|developer)
 * - `instructions`        OpenAI Codex Responses
 * - `systemInstruction`   Google Generative AI / Vertex
 */

const SYS_ROLES = new Set(["system", "developer"]);

type Payload = Record<string, any>;

type Located =
  | { kind: "system-string"; text: string }
  | { kind: "system-blocks"; text: string }
  | { kind: "instructions"; text: string }
  | { kind: "systemInstruction-string"; text: string }
  | { kind: "systemInstruction-parts"; text: string }
  | { kind: "input"; text: string; index: number }
  | { kind: "messages"; text: string; index: number };

function blocksToText(blocks: any[]): string {
  return blocks
    .map((b: any) => (typeof b === "string" ? b : (b?.text ?? "")))
    .join("\n");
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return blocksToText(content);
  return undefined;
}

function findSysIndex(arr: any[]): number {
  return arr.findIndex((m: any) => m && typeof m.role === "string" && SYS_ROLES.has(m.role));
}

function locateSystemPrompt(payload: unknown): Located | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Payload;

  if (typeof p.system === "string") return { kind: "system-string", text: p.system };
  if (Array.isArray(p.system)) return { kind: "system-blocks", text: blocksToText(p.system) };

  if (typeof p.instructions === "string") return { kind: "instructions", text: p.instructions };

  if (typeof p.systemInstruction === "string") {
    return { kind: "systemInstruction-string", text: p.systemInstruction };
  }
  if (p.systemInstruction && typeof p.systemInstruction === "object") {
    const parts = (p.systemInstruction as any).parts;
    if (Array.isArray(parts)) {
      return { kind: "systemInstruction-parts", text: blocksToText(parts) };
    }
  }

  if (Array.isArray(p.input)) {
    const index = findSysIndex(p.input);
    if (index >= 0) {
      const text = contentToText(p.input[index]?.content);
      if (text !== undefined) return { kind: "input", text, index };
    }
  }

  if (Array.isArray(p.messages)) {
    const index = findSysIndex(p.messages);
    if (index >= 0) {
      const text = contentToText(p.messages[index]?.content);
      if (text !== undefined) return { kind: "messages", text, index };
    }
  }

  return undefined;
}

export function extractSystemPromptFromPayload(payload: unknown): string | undefined {
  return locateSystemPrompt(payload)?.text;
}

/**
 * Apply `fn` to the system prompt text inside the payload, preserving block
 * structure (Anthropic content blocks keep their cache_control etc.).
 * Blocks whose text becomes empty after `fn` are dropped.
 * Returns a new payload object, or `undefined` when the shape is unrecognized
 * or nothing changed (caller should then skip replacing the payload).
 */
export function mapSystemPromptInPayload(payload: unknown, fn: (text: string) => string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const loc = locateSystemPrompt(payload);
  if (!loc) return undefined;
  const p = payload as Payload;

  const mapBlocks = (blocks: any[]): { out: any[]; changed: boolean } => {
    const out: any[] = [];
    let changed = false;
    for (const b of blocks) {
      if (typeof b === "string") {
        const t = fn(b);
        if (t !== b) changed = true;
        if (t.trim()) out.push(t);
        continue;
      }
      if (b && typeof b === "object" && typeof b.text === "string") {
        const t = fn(b.text);
        if (t !== b.text) changed = true;
        if (t.trim()) out.push({ ...b, text: t });
        continue;
      }
      out.push(b);
    }
    return { out, changed };
  };

  const mapMessageContent = (msg: any): { next: any; changed: boolean } | undefined => {
    if (typeof msg.content === "string") {
      const t = fn(msg.content);
      if (t === msg.content) return { next: msg, changed: false };
      return { next: { ...msg, content: t }, changed: true };
    }
    if (Array.isArray(msg.content)) {
      const { out, changed } = mapBlocks(msg.content);
      if (!changed) return { next: msg, changed: false };
      return { next: { ...msg, content: out }, changed: true };
    }
    return undefined;
  };

  switch (loc.kind) {
    case "system-string": {
      const t = fn(p.system);
      if (t === p.system) return undefined;
      return { ...p, system: t };
    }
    case "system-blocks": {
      const { out, changed } = mapBlocks(p.system);
      if (!changed) return undefined;
      return { ...p, system: out };
    }
    case "instructions": {
      const t = fn(p.instructions);
      if (t === p.instructions) return undefined;
      return { ...p, instructions: t };
    }
    case "systemInstruction-string": {
      const t = fn(p.systemInstruction);
      if (t === p.systemInstruction) return undefined;
      return { ...p, systemInstruction: t };
    }
    case "systemInstruction-parts": {
      const { out, changed } = mapBlocks(p.systemInstruction.parts);
      if (!changed) return undefined;
      return { ...p, systemInstruction: { ...p.systemInstruction, parts: out } };
    }
    case "input": {
      const mapped = mapMessageContent(p.input[loc.index]);
      if (!mapped?.changed) return undefined;
      const input = p.input.slice();
      input[loc.index] = mapped.next;
      return { ...p, input };
    }
    case "messages": {
      const mapped = mapMessageContent(p.messages[loc.index]);
      if (!mapped?.changed) return undefined;
      const messages = p.messages.slice();
      messages[loc.index] = mapped.next;
      return { ...p, messages };
    }
  }
}
