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

test("applyPromptRules injects today's date when enabled and missing (Pi >= 0.80.7)", () => {
  const prompt = makePrompt().replace(/\nCurrent date: [^\n]*/, "");
  const result = applyPromptRules(prompt, {}, { cwd });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  assert.ok(result.includes(`Current date: ${today}`));
});

test("applyPromptRules does not duplicate an existing date line", () => {
  const result = applyPromptRules(makePrompt(), {}, { cwd });
  assert.strictEqual(result.match(/Current date:/g)!.length, 1);
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

import { removeSkillsBlock } from "../../context-guard/skills.js";
import { stripPromptRules } from "../../context-guard/prompt-rules.js";

test("removeSkillsBlock strips the auto-skills block (autoSkills off)", () => {
  // Pi wraps the block with a blank line before the intro sentence.
  const prompt = makePrompt().replace(
    "The following skills provide specialized instructions...",
    "\nThe following skills provide specialized instructions...",
  );
  const result = removeSkillsBlock(prompt);
  assert.ok(!result.includes("<available_skills>"));
  assert.ok(!result.includes("<skill"));
});

test("stripPromptRules removes disabled layers but never appends", () => {
  const prompt = makePrompt().replace("Current date: 2026-06-22\n", "");
  const result = stripPromptRules(prompt, { roleOverride: false }, { cwd });
  assert.ok(!result.includes("## Role Override"));
  // payload-level enforcement is strip-only: date must not be re-appended.
  assert.ok(!result.includes("Current date:"));
});

test("applyPromptRules strips role override when disabled", () => {
  const result = applyPromptRules(makePrompt(), { roleOverride: false }, { cwd });
  assert.ok(!result.includes("## Role Override"));
  assert.ok(!result.includes("Code like a pro."));
});

test("applyPromptRules strips tool snippets and guidelines when disabled", () => {
  const result = applyPromptRules(makePrompt(), { toolSnippets: false }, { cwd });
  assert.ok(!result.includes("Available tools:"));
  assert.ok(!result.includes("Guidelines:"));
});

test("applyPromptRules strips pi docs block when disabled", () => {
  const result = applyPromptRules(makePrompt(), { piDocs: false }, { cwd });
  assert.ok(!result.includes("Pi documentation"));
  assert.ok(!result.includes("examples/)"));
});

// ── tool gates ──────────────────────────────────────────────

import { syncToolGates, TOOL_GATES } from "../../context-guard/tool-gates.js";

test("tool gates default to enabled (bash)", () => {
  const d = Object.fromEntries(TOOL_GATES.map((g) => [g.id, g.defaultEnabled]));
  assert.strictEqual(d.bash, true);
  assert.strictEqual(Object.keys(d).length, 1);
});

test("syncToolGates removes bash when the gate is off and keeps other tools", () => {
  const active: string[] = [];
  const pi = {
    getActiveTools: () => ["read", "bash", "write"],
    setActiveTools: (tools: string[]) => {
      active.length = 0;
      active.push(...tools);
    },
  };
  syncToolGates(pi as any, { bash: false });
  assert.ok(active.includes("read"));
  assert.ok(active.includes("write"));
  assert.ok(!active.includes("bash"));
});

// ── context notices ─────────────────────────────────────────

import {
  applyContextNotices,
  resetContextNoticesFired,
  getContextNoticesFired,
  reloadContextNoticePrompts,
  NOTICE_60_THRESHOLD,
  NOTICE_70_THRESHOLD,
} from "../../context-guard/context-notices.js";

function noticeCtx(percent: number | null, hasUI = false) {
  return {
    hasUI,
    getContextUsage: () => (percent == null ? undefined : { percent }),
    ui: { notify: () => {} },
  } as any;
}

test("applyContextNotices is one-shot per threshold and fires both on jump", () => {
  resetContextNoticesFired();
  reloadContextNoticePrompts();

  const settings = {
    enabled: true,
    notice60: true,
    notice70: true,
  };

  // Below threshold — nothing
  assert.strictEqual(applyContextNotices([], settings, noticeCtx(50)), undefined);

  // Jump past both: should fire 60 then 70 in one call
  const msgs = applyContextNotices([{ role: "user", content: "hi" }], settings, noticeCtx(75));
  assert.ok(msgs);
  assert.strictEqual(msgs!.length, 3); // original + 2 notices
  const types = msgs!.filter((m: any) => m.role === "custom").map((m: any) => m.customType);
  assert.deepStrictEqual(types, [
    `context-notice-${NOTICE_60_THRESHOLD}`,
    `context-notice-${NOTICE_70_THRESHOLD}`,
  ]);

  const fired = getContextNoticesFired();
  assert.strictEqual(fired.notice60, true);
  assert.strictEqual(fired.notice70, true);

  // Second call does not re-fire
  assert.strictEqual(applyContextNotices([], settings, noticeCtx(90)), undefined);
});

test("applyContextNotices respects master off and per-threshold toggles", () => {
  resetContextNoticesFired();
  reloadContextNoticePrompts();

  assert.strictEqual(
    applyContextNotices([], { enabled: false, notice60: true, notice70: true }, noticeCtx(80)),
    undefined,
  );

  // Only 70 enabled — 60 skipped even if crossed
  const msgs = applyContextNotices(
    [],
    { enabled: true, notice60: false, notice70: true },
    noticeCtx(80),
  );
  assert.ok(msgs);
  assert.strictEqual(msgs!.length, 1);
  assert.strictEqual((msgs![0] as any).customType, "context-notice-70");
  assert.strictEqual(getContextNoticesFired().notice60, false);
  assert.strictEqual(getContextNoticesFired().notice70, true);
});

test("applyContextNotices ignores missing usage", () => {
  resetContextNoticesFired();
  assert.strictEqual(
    applyContextNotices([], { enabled: true, notice60: true, notice70: true }, noticeCtx(null)),
    undefined,
  );
});

// ── bash render ─────────────────────────────────────────────

import {
  createBashCallComponent,
  formatBashBody,
  formatBashCall,
  syncBashTimer,
  PREVIEW_LINES,
  type BashTimerState,
} from "../../context-guard/bash-render.js";

const fakeTheme = {
  fg: (c: string, t: string) => `[${c}]${t}[/${c}]`,
  bold: (t: string) => `*${t}*`,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

test("formatBashCall is multi-line: header + body", () => {
  const text = formatBashCall("echo hello", 120, fakeTheme, undefined);
  const lines = text.split("\n");
  assert.ok(lines.length >= 2);
  assert.ok(lines[0].includes("$"));
  assert.ok(lines[0].includes("timeout 2m"));
  assert.ok(!lines[0].includes("echo hello")); // command is body, not header
  assert.ok(text.includes("echo hello"));
});

test("formatBashCall keeps long one-liner fully in body (no char truncate)", () => {
  const long = `cd /c/10x001/sys_cleanup && python scripts/cleanup.py execute --approve "plans/cleanup_plan_20260803_041533.json" --dry-run --verbose`;
  const text = formatBashCall(long, 120, fakeTheme, undefined);
  assert.ok(text.includes("cleanup_plan_20260803_041533.json"));
  assert.ok(text.includes("--dry-run"));
  assert.ok(text.includes("timeout 2m"));
});

test("formatBashBody caps at PREVIEW_LINES with remainder hint", () => {
  const cmd = Array.from({ length: PREVIEW_LINES + 5 }, (_, i) => `echo line${i}`).join("\n");
  const body = formatBashBody(cmd, fakeTheme);
  assert.strictEqual(body.length, PREVIEW_LINES + 1); // lines + suffix
  assert.ok(body[body.length - 1].includes("+5"));
});

test("formatBashCall includes elapsed timer suffix on header", () => {
  const text = formatBashCall("true", undefined, fakeTheme, 12_000);
  const header = text.split("\n")[0];
  assert.ok(header.includes("12s"));
});

test("an expanded row lifts the command cap (Ctrl+O is the escape hatch)", () => {
  const cmd = Array.from({ length: PREVIEW_LINES + 12 }, (_, i) => `echo line${i}`).join("\n");
  const collapsed = formatBashBody(cmd, fakeTheme);
  assert.ok(collapsed[collapsed.length - 1].includes("+12"));
  const expanded = formatBashBody(cmd, fakeTheme, Number.POSITIVE_INFINITY);
  assert.strictEqual(expanded.length, PREVIEW_LINES + 12);
  assert.ok(!expanded.join("").includes("…"));
});

test("bash timer: hidden under the threshold, frozen after the row settles", () => {
  const state: BashTimerState = {};
  const invalidate = () => {};
  const t0 = 1_000_000;

  // running, 2 s in → below the 5 s threshold, nothing shown, interval installed
  assert.strictEqual(
    syncBashTimer(state, { executionStarted: true, isPartial: true, invalidate, now: t0 }),
    undefined,
  );
  assert.ok(state.interval !== undefined);

  // running, 12 s in → visible while it runs
  assert.strictEqual(
    syncBashTimer(state, { executionStarted: true, isPartial: true, invalidate, now: t0 + 12_000 }),
    12_000,
  );

  // settled → the interval stops and the value stays (this is what the old build lost)
  assert.strictEqual(
    syncBashTimer(state, { executionStarted: true, isPartial: false, invalidate, now: t0 + 12_500 }),
    12_500,
  );
  assert.strictEqual(state.interval, undefined);
  // later renders (resize, Ctrl+O) keep the same frozen value
  assert.strictEqual(
    syncBashTimer(state, { executionStarted: true, isPartial: false, invalidate, now: t0 + 900_000 }),
    12_500,
  );
});

test("bash timer: a command under the threshold stays clean after settling", () => {
  const state: BashTimerState = {};
  syncBashTimer(state, { executionStarted: true, isPartial: true, invalidate: () => {}, now: 0 });
  assert.strictEqual(
    syncBashTimer(state, { executionStarted: true, isPartial: false, invalidate: () => {}, now: 400 }),
    undefined,
  );
});

test("bash timer: no value when the call never started (denied or aborted)", () => {
  const state: BashTimerState = {};
  assert.strictEqual(
    syncBashTimer(state, { executionStarted: false, isPartial: false, invalidate: () => {} }),
    undefined,
  );
  assert.strictEqual(state.startedAt, undefined);
  assert.strictEqual(state.endedAt, undefined);
});

test("createBashCallComponent keeps timer state on context.state, not on the component", () => {
  const context = {
    toolCallId: "t1",
    state: {} as { bashTimer?: BashTimerState },
    expanded: false,
    executionStarted: true,
    isPartial: true,
    invalidate: () => {},
    lastComponent: undefined,
  };
  const start = Date.now() - 12_000;
  createBashCallComponent({ command: "sleep 12" }, fakeTheme, context);
  context.state.bashTimer!.startedAt = start;
  const text = createBashCallComponent({ command: "sleep 12" }, fakeTheme, context);
  assert.ok(context.state.bashTimer, "state lives on the render context");
  assert.ok((text.render(60).join("\n")).includes("12s"), "header keeps the running clock");
  context.isPartial = false;
  const settled = createBashCallComponent({ command: "sleep 12" }, fakeTheme, context);
  assert.ok((settled.render(60).join("\n")).includes("12s"), "and keeps it after the row settles");
  if (context.state.bashTimer?.interval) clearInterval(context.state.bashTimer.interval);
});

test("buildBootBannerLines lists only enabled features", async () => {
  const { buildBootBanner, buildBootBannerLines } = await import("../../context-guard/tui.js");
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const plain = (lines: string[]) => lines.map(stripAnsi);

  const allOnLines = buildBootBannerLines(
    {
      promptRules: {},
      features: {},
      autoSkills: true,
      agentsInject: true,
      contextNotices: { enabled: false, notice60: true, notice70: true },
    },
    { cwd: "C:/projects/example", role: "base-v21", reason: "new" },
  );
  const allOn = plain(allOnLines);
  assert.equal(allOn.length, 2);
  assert.match(allOn[0], /^prompt/);
  assert.match(allOn[0], /agents\.md/);
  assert.match(allOn[0], /agents-msg/);
  assert.match(allOn[1], /^tools/);
  assert.match(allOn[1], /bash/);
  assert.match(allOn[1], /auto-skills/);
  assert.ok(!allOn.join("\n").includes("notices"));
  assert.ok(!allOn.join("\n").includes("✗"));
  assert.ok(!allOn.join("\n").includes("context-guard ·"));
  assert.ok(!allOn.join("\n").includes("C:/projects/example"));
  assert.equal(buildBootBanner(
    {
      promptRules: {},
      features: {},
      autoSkills: true,
      agentsInject: true,
      contextNotices: { enabled: false, notice60: true, notice70: true },
    },
    { cwd: "C:/projects/example", role: "base-v21", reason: "new" },
  ), allOnLines.join("\n"));

  const someOff = buildBootBannerLines(
    {
      promptRules: { agents: false, cwd: false, date: false },
      features: { bash: false },
      autoSkills: false,
      agentsInject: false,
      contextNotices: { enabled: true, notice60: true, notice70: false },
    },
    { cwd: "C:/tmp", reason: "startup" },
  );
  const off = plain(someOff);
  const blob = off.join("\n");
  assert.ok(!blob.includes("date"));
  assert.ok(!blob.includes("workdir"));
  assert.ok(!blob.includes("agents.md"));
  assert.ok(!blob.includes("agents-msg"));
  assert.ok(!blob.includes("bash"));
  assert.ok(!blob.includes("auto-skills"));
  assert.ok(!blob.includes("✗"));
  assert.match(off[0], /^prompt/);
  assert.match(blob, /tool list/);
  assert.match(blob, /^notices/m);
  assert.match(blob, /\b60\b/);
  assert.ok(!blob.includes("70"));
});


// ── AGENTS.md first-message inject ──────────────────────────

import {
  AGENTS_INJECT_TYPE,
  formatAgentsInjectMessage,
  injectAgentsIfNeeded,
  readCwdAgentsFile,
  shouldInjectAgents,
} from "../../context-guard/agents-inject.js";

test("formatAgentsInjectMessage is banner then raw file", () => {
  assert.equal(
    formatAgentsInjectMessage("C:\\10x001\\pi extensions\\AGENTS.md", "# hi\nBe brief.\n"),
    "Follow this project guide. Full file already below. Disk only if editing: C:/10x001/pi extensions/AGENTS.md\n\n# hi\nBe brief.\n",
  );
});

test("missing AGENTS.md sends no inject message", () => {
  const missingCwd = "C:/this-cwd-has-no-agents-md";
  assert.equal(readCwdAgentsFile(missingCwd), null);
  const sent: unknown[] = [];
  const ok = injectAgentsIfNeeded(
    { sendMessage: (m) => sent.push(m) },
    { cwd: missingCwd, sessionManager: { getEntries: () => [] } },
    true,
  );
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
});

test("shouldInjectAgents skips child, off, existing inject, and non-empty sessions", () => {
  const empty: [] = [];
  assert.equal(shouldInjectAgents({ isChild: false, enabled: true, entries: empty }), true);
  assert.equal(shouldInjectAgents({ isChild: true, enabled: true, entries: empty }), false);
  assert.equal(shouldInjectAgents({ isChild: false, enabled: false, entries: empty }), false);
  assert.equal(
    shouldInjectAgents({
      isChild: false,
      enabled: true,
      entries: [{ type: "custom_message", customType: AGENTS_INJECT_TYPE }],
    }),
    false,
  );
  assert.equal(
    shouldInjectAgents({
      isChild: false,
      enabled: true,
      entries: [{ type: "message", message: { role: "user" } }],
    }),
    false,
  );
  assert.equal(
    shouldInjectAgents({
      isChild: false,
      enabled: true,
      entries: [{ type: "custom", customType: "role-switcher" }],
    }),
    true,
  );
});

test("getRoleSize resolves a role by family alias from the roles dir", async () => {
  const { getRoleSize } = await import("../../context-guard/prompt-rules.js");
  const { ROLES_DIR } = await import("../../role-sw/roles.js");
  const { mkdirSync, writeFileSync, unlinkSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  // Role files live at runtime, not in the repo, so the case seeds the dir it probes first.
  mkdirSync(ROLES_DIR, { recursive: true });
  const fixture = join(ROLES_DIR, `zzcg-size-v2.md`);
  writeFileSync(fixture, "## Role\n" + "x".repeat(400) + "\n", "utf-8");
  try {
    const byAlias = getRoleSize("zzcg-size");
    assert.ok(byAlias > 0);
    // A stale concrete version resolves to the same file as the alias.
    assert.strictEqual(getRoleSize("zzcg-size-v1"), byAlias,
      "versioned request in a family resolves to the newest file");
  } finally {
    if (existsSync(fixture)) unlinkSync(fixture);
  }
});

test("buildInspectReport shows first-message AGENTS and pre-turn canary", async () => {
  const { buildInspectReport } = await import("../../context-guard/inspect.js");
  const { AGENTS_INJECT_TYPE } = await import("../../context-guard/agents-inject.js");
  const settings = {
    promptRules: { date: false },
    features: {},
    autoSkills: false,
    agentsInject: true,
    contextNotices: { enabled: false, notice60: true, notice70: true },
  };
  const report = buildInspectReport(
    "ROLE_SW_REQUIRED\nCurrent working directory: C:/10x001/pi extensions\n",
    { cwd: "C:/10x001/pi extensions", customPrompt: "ROLE_SW_REQUIRED", contextFiles: [], skills: [] },
    settings,
    [{ type: "custom", customType: "role-switcher", data: { role: "sub-default" } }],
  );
  assert.match(report, /not the role the model will see/);
  assert.match(report, /\[AGENTS\.md\] not in system prompt/);
  assert.match(report, /first-message: will send on this empty session/);
  assert.match(report, /C:\/10x001\/pi extensions\/AGENTS\.md/);
  assert.match(report, /\[Role\] sub-default \(~\d+ tok\)/);
  assert.match(report, /date: OFF/);
  assert.match(report, /cwd:  in prompt/);

  const resumed = buildInspectReport(
    "x",
    { cwd: "C:/10x001/pi extensions", customPrompt: "x", contextFiles: [] },
    settings,
    [{ type: "custom_message", customType: AGENTS_INJECT_TYPE }],
  );
  assert.match(resumed, /first-message: already in this session/);
});

