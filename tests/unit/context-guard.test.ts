import { test } from "node:test";
import assert from "node:assert";
import { applyPromptRules } from "../../context-guard/prompt-rules.js";

const cwd = "C:/10x001/project";

function makePrompt(): string {
  return [
    "You are Pi.",
    "Current date: 2026-06-22",
    "Current working directory: C:/10x001/project",
    "<project_context>",
    "Project-specific instructions and guidelines:",
    '<project_instructions path="C:/10x001/project/AGENTS.md">',
    "# AGENTS.md",
    "Be concise.",
    "</project_instructions>",
    '<project_instructions path="C:/some/ancestor/CLAUDE.md">',
    "# CLAUDE.md",
    "Be helpful.",
    "</project_instructions>",
    "</project_context>",
    "The following skills provide specialized instructions...",
    "<available_skills>",
    "<skill name=\"test\">desc</skill>",
    "</available_skills>",
    "Pi documentation (read only when relevant): examples/)",
    "- foo",
    "- bar",
    "Available tools:",
    "- read",
    "- write",
    "Guidelines:",
    "- be nice",
    "## Role Override (coder)",
    "Code like a pro.",
  ].join("\n");
}

test("applyPromptRules keeps everything when all rules enabled", () => {
  const prompt = makePrompt();
  const result = applyPromptRules(prompt, {}, { cwd });
  assert.ok(result.includes("Current date:"));
  assert.ok(result.includes("<project_context>"));
  assert.ok(result.includes("## Role Override"));
});

test("applyPromptRules strips date when disabled", () => {
  const result = applyPromptRules(makePrompt(), { date: false }, { cwd });
  assert.ok(!result.includes("Current date:"));
  assert.ok(result.includes("<project_context>"));
});

test("applyPromptRules strips cwd when disabled", () => {
  const result = applyPromptRules(makePrompt(), { cwd: false }, { cwd });
  assert.ok(!result.includes("Current working directory:"));
});

test("applyPromptRules strips entire project_context when agents disabled", () => {
  const result = applyPromptRules(makePrompt(), { agents: false }, { cwd });
  assert.ok(!result.includes("<project_context>"));
  assert.ok(!result.includes("AGENTS.md"));
});

test("applyPromptRules keeps only cwd-matching instructions when ancestorAgents disabled", () => {
  const result = applyPromptRules(makePrompt(), { ancestorAgents: false }, { cwd });
  assert.ok(result.includes("Be concise."));
  assert.ok(!result.includes("Be helpful."));
});

test("applyPromptRules strips skills block when disabled", () => {
  const result = applyPromptRules(makePrompt(), { skills: false }, { cwd });
  assert.ok(!result.includes("<available_skills>"));
  assert.ok(!result.includes("<skill"));
});

test("applyPromptRules strips role override when disabled", () => {
  const result = applyPromptRules(makePrompt(), { roleOverride: false }, { cwd });
  assert.ok(!result.includes("## Role Override"));
  assert.ok(!result.includes("Code like a pro."));
});
