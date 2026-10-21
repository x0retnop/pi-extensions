import assert from "node:assert";
import { describe, it } from "node:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import {
  loadBuiltinAgents,
  visibleAgents,
  formatAgentList,
  type AgentConfig,
} from "../../sub-agents/agents.js";
import {
  resolveAgent,
  stripLegacySettings,
  TOOL_EXTENSION_MAP,
  TOOL_PRESETS,
  formatEffective,
  favoriteModelChoices,
  type SubAgentsSettings,
} from "../../sub-agents/settings.js";
import {
  buildPiArgs,
  buildResumePrompt,
  makeChildSessionId,
  requiredExtensionsForTools,
  isFailedResult,
  getResultOutput,
  shouldRetrySpawn,
  evaluateGuards,
  canExtendCap,
  effectiveHardMs,
  effectiveMaxTurns,
  nextDeadline,
  progressDeadline,
  resolveGuardLimits,
  formatDuration,
  formatTranscript,
  GUARD_DEFAULTS,
  type GuardLimits,
  type GuardSnapshot,
  type SingleResult,
} from "../../sub-agents/runner.js";
import {
  applySubAgentsSection,
  containsSubAgentsMarker,
  loadParentSection,
  resolveSubAgentsEnabled,
} from "../../sub-agents/parent-prompt.js";

function baseAgent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "test",
    systemPrompt: "do the thing",
    source: "builtin",
    filePath: "/tmp/worker.md",
    ...over,
  };
}

describe("sub-agents favoriteModelChoices", () => {
  it("keeps /mm favorite order and skips pins without a model id", () => {
    const choices = favoriteModelChoices({
      favorites: [
        { providerId: "opencode-go", modelId: "deepseek-v4-flash" },
        { providerId: "kimi-coding", modelId: "kimi-for-coding" },
        { providerId: "orphan" },
        { providerId: "xai", modelId: "grok-4.6" },
      ],
    });
    assert.deepStrictEqual(
      choices.map((c) => c.id),
      ["opencode-go/deepseek-v4-flash", "kimi-coding/kimi-for-coding", "xai/grok-4.6"],
    );
  });

  it("resolves a provider-only pin via lastUsedModel and appends display names", () => {
    const choices = favoriteModelChoices(
      {
        favorites: [
          { providerId: "xai" },
          { providerId: "xai", modelId: "grok-4.6" },
        ],
        providers: [{ id: "xai", lastUsedModel: "grok-4.6" }],
      },
      { "xai/grok-4.6": "grok 4.6 f" },
    );
    assert.deepStrictEqual(choices, [{ id: "xai/grok-4.6", label: "xai/grok-4.6 · grok 4.6 f" }]);
  });
});

describe("sub-agents TOOL_EXTENSION_MAP", () => {
  it("maps pwsh/py to pi-agent-run only", () => {
    assert.strictEqual(TOOL_EXTENSION_MAP.pwsh, "pi-agent-run");
    assert.strictEqual(TOOL_EXTENSION_MAP.py, "pi-agent-run");
    assert.strictEqual(TOOL_EXTENSION_MAP.edit, undefined);
    assert.strictEqual(TOOL_EXTENSION_MAP.grep, undefined);
  });

  it("requiredExtensionsForTools dedupes and ignores unknown tools", () => {
    assert.deepStrictEqual(requiredExtensionsForTools(["read", "pwsh", "py", "bash"]), [
      "pi-agent-run",
    ]);
    assert.deepStrictEqual(requiredExtensionsForTools(["read", "grep"]), []);
    assert.deepStrictEqual(requiredExtensionsForTools(undefined), []);
  });
});

describe("sub-agents resolveAgent", () => {
  const settings: SubAgentsSettings = {
    defaultRole: "sub-default",
    agentOverrides: {
      worker: {
        model: "opencode-go/deepseek-v4-flash",
        role: "sub-ds-v4-flash",
        tools: ["read", "grep"],
        maxTurns: 12,
        timeoutMs: 60_000,
      },
      bare: { role: "none" },
    },
  };

  it("applies per-agent override over frontmatter and defaultRole", () => {
    const resolved = resolveAgent(
      baseAgent({ model: "old/model", role: "frontmatter-role", tools: ["bash"], maxTurns: 3 }),
      settings,
    );
    assert.strictEqual(resolved.model, "opencode-go/deepseek-v4-flash");
    assert.strictEqual(resolved.role, "sub-ds-v4-flash");
    assert.deepStrictEqual(resolved.tools, ["read", "grep"]);
    assert.strictEqual(resolved.maxTurns, 12);
    assert.strictEqual(resolved.timeoutMs, 60_000);
  });

  it("uses defaultRole when no frontmatter role and no override", () => {
    const resolved = resolveAgent(baseAgent({ name: "other" }), settings);
    assert.strictEqual(resolved.role, "sub-default");
  });

  it("role 'none' in override disables role composition", () => {
    const resolved = resolveAgent(baseAgent({ name: "bare", role: "frontmatter-role" }), settings);
    assert.strictEqual(resolved.role, undefined);
  });

  it("rejects non-positive numeric overrides", () => {
    const s: SubAgentsSettings = {
      agentOverrides: {
        worker: { maxTurns: 0, timeoutMs: -5 },
      },
    };
    const resolved = resolveAgent(baseAgent({ maxTurns: 9, timeoutMs: 1000 }), s);
    assert.strictEqual(resolved.maxTurns, 9);
    assert.strictEqual(resolved.timeoutMs, 1000);
  });

  it("stripLegacySettings drops old extension-policy keys", () => {
    const cleaned = stripLegacySettings({
      defaultRole: "sub-legacy",
      debugLog: true,
      defaultExtensionsPolicy: "custom",
      defaultCustomExtensions: ["grep-tool"],
      agentExtensions: { "legacy-worker": { policy: "custom" } },
      parallelConcurrency: 3,
      lastAgent: "legacy-agent",
      lastMode: "single",
    } as SubAgentsSettings);
    assert.strictEqual(cleaned.defaultRole, "sub-legacy");
    assert.strictEqual(cleaned.debugLog, true);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(cleaned, "defaultExtensionsPolicy"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(cleaned, "defaultCustomExtensions"),
      false,
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, "agentExtensions"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, "parallelConcurrency"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, "lastAgent"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, "lastMode"), false);
  });

  it("formatEffective summarizes model/role/tools", () => {
    const text = formatEffective(
      baseAgent({ model: "m", role: "r", tools: ["read", "grep"] }),
    );
    assert.strictEqual(text, "m · r · read+grep");
  });
});

describe("sub-agents buildPiArgs", () => {
  it("role agents get --no-context-files --no-skills", () => {
    const args = buildPiArgs(
      baseAgent({ role: "sub-ds-v4-flash", model: "opencode-go/deepseek-v4-flash" }),
      null,
    );
    assert.ok(args.includes("--no-context-files"));
    assert.ok(args.includes("--no-skills"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("opencode-go/deepseek-v4-flash"));
    assert.ok(args.includes("--exclude-tools"));
    assert.ok(args.includes("spawn_agent"));
  });

  it("includeExtensions true loads all extensions (no --no-extensions)", () => {
    const args = buildPiArgs(
      baseAgent({
        includeExtensions: true,
        tools: ["read", "pwsh"],
      }),
      null,
    );
    assert.ok(!args.includes("--no-extensions"));
    assert.ok(!args.some((a) => a.includes("pi-agent-run")));
  });

  it("without includeExtensions, auto-loads pi-agent-run for pwsh/py", () => {
    const args = buildPiArgs(
      baseAgent({
        includeExtensions: false,
        tools: ["read", "pwsh", "py"],
      }),
      null,
    );
    assert.ok(args.includes("--no-extensions"));
    const extIdx = args.indexOf("--extension");
    assert.ok(extIdx >= 0);
    const extPath = args[extIdx + 1];
    assert.ok(extPath.includes(path.join("extensions", "pi-agent-run")));
    // Exactly one extension entry for both tools
    assert.strictEqual(args.filter((a) => a === "--extension").length, 1);
  });

  it("explicit extensions list merges with auto-required tools", () => {
    const args = buildPiArgs(
      baseAgent({
        includeExtensions: false,
        tools: ["pwsh"],
        extensions: ["read-mode"],
      }),
      null,
    );
    const extPaths = args
      .map((a, i) => (a === "--extension" ? args[i + 1] : null))
      .filter((x): x is string => !!x);
    assert.strictEqual(extPaths.length, 2);
    assert.ok(extPaths.some((p) => p.endsWith(path.join("extensions", "read-mode")) || p.includes(`${path.sep}read-mode`)));
    assert.ok(extPaths.some((p) => p.includes("pi-agent-run")));
  });

  it("no tools and no includeExtensions → --no-extensions only", () => {
    const args = buildPiArgs(baseAgent({ includeExtensions: false }), null);
    assert.ok(args.includes("--no-extensions"));
    assert.ok(!args.includes("--extension"));
  });

  it("passes --tools and --append-system-prompt when provided", () => {
    const args = buildPiArgs(
      baseAgent({ tools: ["read", "grep", "bash"] }),
      "C:/tmp/prompt.md",
    );
    assert.ok(args.includes("--tools"));
    assert.ok(args.includes("read,grep,bash"));
    assert.ok(args.includes("--append-system-prompt"));
    assert.ok(args.includes("C:/tmp/prompt.md"));
  });

  it("absolute extension paths are kept as-is", () => {
    const abs = path.join(os.tmpdir(), "my-ext");
    const args = buildPiArgs(
      baseAgent({ includeExtensions: false, extensions: [abs] }),
      null,
    );
    assert.ok(args.includes(abs));
  });
});

describe("sub-agents builtin agent definitions", () => {
  it("loads exactly the three spawn agents plus the hidden handoff agent", async () => {
    const agents = await loadBuiltinAgents();
    const names = agents.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ["coder", "explorer", "handoff-instr", "reviewer"]);
    for (const a of agents) {
      assert.ok(a.name, "name required");
      assert.ok(a.description, "description required");
      assert.strictEqual(a.source, "builtin");
      assert.ok(a.filePath.endsWith(".md"));
    }
  });

  it("hidden handoff agents are filtered by visibleAgents", async () => {
    const agents = await loadBuiltinAgents();
    const hidden = agents.filter((a) => a.hidden);
    assert.ok(hidden.length >= 1, "expected at least one hidden handoff agent");
    const vis = visibleAgents(agents);
    assert.ok(vis.every((a) => !a.hidden));
    assert.ok(vis.length < agents.length);
  });

  it("spawn agents keep the full tool set and load extensions", async () => {
    const agents = await loadBuiltinAgents();
    for (const name of ["explorer", "reviewer", "coder"]) {
      const agent = agents.find((a) => a.name === name);
      assert.ok(agent, `${name} missing`);
      assert.ok(agent!.includeExtensions, `${name} must load extensions`);
      // No allowlist: the child inherits every tool except spawn_agent, which the
      // runner excludes from the CLI args.
      assert.strictEqual(agent!.tools, undefined, `${name} must not restrict tools`);
    }
  });

  it("children get a named session so a respawn can resume them", () => {
    const args = buildPiArgs(baseAgent(), null, { id: "sub-coder-abc", dir: "C:/tmp/subs" });
    assert.ok(!args.includes("--no-session"));
    const id = args.indexOf("--session-id");
    assert.ok(id > -1, "expected --session-id");
    assert.strictEqual(args[id + 1], "sub-coder-abc");
    const dir = args.indexOf("--session-dir");
    assert.ok(dir > -1, "expected --session-dir");
    assert.strictEqual(args[dir + 1], "C:/tmp/subs");
  });

  it("without a session the child stays ephemeral (--no-session)", () => {
    const args = buildPiArgs(baseAgent(), null);
    assert.ok(args.includes("--no-session"));
    assert.ok(!args.includes("--session-id"));
  });

  it("resume prompt is a nudge, not a second brief", () => {
    const prompt = buildResumePrompt("429: upstream unavailable", 2);
    assert.match(prompt, /429: upstream unavailable/);
    assert.match(prompt, /attempt 2/);
    assert.match(prompt, /do not redo work/i);
    assert.match(prompt, /state of the working tree/i);
  });

  it("child session ids are unique per run and carry the agent name", () => {
    const a = makeChildSessionId("coder");
    const b = makeChildSessionId("coder");
    assert.notStrictEqual(a, b);
    assert.match(a, /^sub-coder-/);
    assert.ok(a.length < 64);
  });

  it("runner excludes spawn_agent from every child", () => {
    const args = buildPiArgs(baseAgent(), null);
    const i = args.indexOf("--exclude-tools");
    assert.ok(i !== -1, "expected --exclude-tools");
    assert.strictEqual(args[i + 1], "spawn_agent");
  });

  it("formatAgentList returns names", async () => {
    const agents = await loadBuiltinAgents();
    const text = formatAgentList(visibleAgents(agents));
    assert.ok(text.length > 0);
    assert.notStrictEqual(text, "none");
  });

  it("worker tool preset includes edit tools and pwsh/py", () => {
    assert.deepStrictEqual(TOOL_PRESETS.worker, [
      "read",
      "grep",
      "bash",
      "pwsh",
      "py",
      "edit",
      "write",
      "multi_edit",
    ]);
    assert.ok(TOOL_PRESETS["read-only-win"].includes("pwsh"));
  });
});

describe("sub-agents guards", () => {
  const limits: GuardLimits = {
    hardMs: 3_600_000,
    maxTurns: 300,
    deadlineMs: 1_200_000,
    idleMs: 600_000,
    toolIdleMs: 1_800_000,
    contextLimitPercent: 40,
    maxExtensions: 2,
    extendGraceMs: 600_000,
  };
  const t0 = 1_000_000;
  const base = (over: Partial<GuardSnapshot> = {}): GuardSnapshot => ({
    startedAt: t0,
    lastOutputAt: t0,
    lastTurnAt: t0,
    deadlineAt: nextDeadline(t0, t0, limits),
    toolsInFlight: 0,
    turns: 1,
    extensionsUsed: 0,
    ...over,
  });

  it("keeps a productive run going past the first deadline", () => {
    const now = t0 + limits.deadlineMs + 60_000;
    // The turn that just completed pushed the deadline forward two minutes ago.
    const snapshot = base({ lastOutputAt: now - 1_000, lastTurnAt: now - 1_000, deadlineAt: now + limits.deadlineMs - 1_000 });
    assert.strictEqual(evaluateGuards(now, snapshot, limits).reason, null);
  });

  it("stops a run that completes no turn for the whole deadline", () => {
    const now = t0 + limits.deadlineMs;
    const { reason } = evaluateGuards(now, base({ lastOutputAt: now - 1_000 }), limits);
    assert.match(reason ?? "", /no completed turn/);
  });

  it("tolerates a silent tool call up to toolIdleMs", () => {
    const duringTool = t0 + limits.idleMs + 60_000;
    assert.strictEqual(evaluateGuards(duringTool, base({ toolsInFlight: 1 }), limits).reason, null);
    // ...but not beyond it.
    const tooLong = t0 + limits.toolIdleMs;
    assert.match(evaluateGuards(tooLong, base({ toolsInFlight: 1 }), limits).reason ?? "", /tool silent/);
  });

  it("suspends the deadline while a tool runs — a turn cannot complete until it returns", () => {
    const now = t0 + limits.deadlineMs + 5_000;
    assert.strictEqual(evaluateGuards(now, base({ toolsInFlight: 1, deadlineAt: t0 + 1_000 }), limits).reason, null);
  });

  it("stops on the hard caps regardless of activity", () => {
    const active = (now: number) => base({ lastOutputAt: now - 500, lastTurnAt: now - 500, deadlineAt: now + limits.deadlineMs });
    const hard = evaluateGuards(t0 + limits.hardMs, active(t0 + limits.hardMs), limits);
    assert.match(hard.reason ?? "", /hard limit/);
    assert.strictEqual(hard.cap, "time");
    const turns = evaluateGuards(t0 + 1_000, base({ turns: limits.maxTurns + 1, lastOutputAt: t0 + 1_000, lastTurnAt: t0 + 1_000 }), limits);
    assert.match(turns.reason ?? "", /turn cap/);
    assert.strictEqual(turns.cap, "turns");
  });

  it("stops when the child fills its context window", () => {
    const now = t0 + 5_000;
    const { reason } = evaluateGuards(now, base({ lastOutputAt: now - 500, lastTurnAt: now - 500, contextPercent: 41, contextWindow: 200_000 }), limits);
    assert.match(reason ?? "", /context at 41%/);
    // Under the limit it keeps running.
    assert.strictEqual(
      evaluateGuards(now, base({ lastOutputAt: now - 500, lastTurnAt: now - 500, contextPercent: 39, contextWindow: 200_000 }), limits).reason,
      null,
    );
  });

  it("context limit 0 disables the check", () => {
    const now = t0 + 5_000;
    const off = { ...limits, contextLimitPercent: 0 };
    assert.strictEqual(
      evaluateGuards(now, base({ lastOutputAt: now - 500, lastTurnAt: now - 500, contextPercent: 99, contextWindow: 200_000 }), off).reason,
      null,
    );
  });

  it("a productive run at the hard cap is offered an extension, a stalled one is not", () => {
    const atCap = t0 + limits.hardMs;
    // A turn completed a second ago — active run.
    const active = base({ lastOutputAt: atCap - 1_000, lastTurnAt: atCap - 1_000, deadlineAt: atCap + limits.deadlineMs });
    const decision = evaluateGuards(atCap, active, limits);
    assert.strictEqual(decision.cap, "time");
    assert.ok(canExtendCap(atCap, active, limits));
    // A run silent since before the grace window — no extension.
    const stalled = base({ lastOutputAt: atCap - limits.idleMs, lastTurnAt: atCap - limits.extendGraceMs - 1_000, deadlineAt: atCap + limits.deadlineMs });
    const stalledDecision = evaluateGuards(atCap, stalled, limits);
    assert.strictEqual(stalledDecision.cap, "time");
    assert.ok(!canExtendCap(atCap, stalled, limits));
  });

  it("an extension adds 50% of the base cap and keeps the run alive", () => {
    assert.strictEqual(effectiveHardMs(limits, 1), limits.hardMs + limits.hardMs / 2);
    assert.strictEqual(effectiveHardMs(limits, 2), limits.hardMs * 2);
    assert.strictEqual(effectiveMaxTurns(limits, 1), 450);
    assert.strictEqual(effectiveMaxTurns(limits, 2), 600);
    const now = t0 + limits.hardMs + 60_000;
    // After one extension the 1h+1m run is below the 1.5h effective ceiling.
    const snapshot = base({ lastOutputAt: now - 1_000, lastTurnAt: now - 1_000, deadlineAt: now + limits.deadlineMs, extensionsUsed: 1 });
    assert.strictEqual(evaluateGuards(now, snapshot, limits).reason, null);
    // ...and the reason of a final stop names the effective ceiling + extensions.
    const final = evaluateGuards(t0 + limits.hardMs * 2, base({ lastOutputAt: t0, lastTurnAt: t0, extensionsUsed: 2 }), limits);
    assert.match(final.reason ?? "", /hard limit reached \(2h 00m \(incl\. 2 extensions\)\)/);
  });

  it("extensions run out: maxExtensions 0 or exhausted stops at the cap", () => {
    const noExt = { ...limits, maxExtensions: 0 };
    const atCap = t0 + limits.hardMs;
    const active = base({ lastOutputAt: atCap - 1_000, lastTurnAt: atCap - 1_000, deadlineAt: atCap + limits.deadlineMs });
    assert.ok(!canExtendCap(atCap, active, noExt));
    const exhausted = base({ lastOutputAt: atCap - 1_000, lastTurnAt: atCap - 1_000, extensionsUsed: limits.maxExtensions });
    assert.ok(!canExtendCap(atCap, exhausted, limits));
    // grace 0 disables extensions too
    assert.ok(!canExtendCap(atCap, active, { ...limits, extendGraceMs: 0 }));
  });

  it("nextDeadline extends by a full deadline but never past the hard ceiling", () => {
    const limits2 = { ...limits, hardMs: 100_000, deadlineMs: 40_000 };
    assert.strictEqual(nextDeadline(t0 + 10_000, t0, limits2), t0 + 50_000);
    assert.strictEqual(nextDeadline(t0 + 90_000, t0, limits2), t0 + 100_000);
  });

  it("a disabled hard cap never clamps the deadline to the start", () => {
    const off = { ...limits, hardMs: 0 };
    assert.strictEqual(nextDeadline(t0 + 30_000, t0, off), t0 + 30_000 + off.deadlineMs);
  });

  it("progress after a granted extension re-anchors at the extended ceiling, not the base one", () => {
    // coder's shape: 45 min base cap, one extension → 1h 07m 30s effective ceiling.
    const limits2 = { ...limits, hardMs: 2_700_000, deadlineMs: 1_200_000 };
    const afterBaseCap = t0 + limits2.hardMs + 4_000;
    assert.strictEqual(progressDeadline(afterBaseCap, t0, limits2, 1), afterBaseCap + limits2.deadlineMs);
    // The distinguishing case: a tool call ends 26 s later. Clamping to the base
    // ceiling would put the deadline in the past and stop the run instantly.
    const toolEnded = afterBaseCap + 26_000;
    const deadline = progressDeadline(toolEnded, t0, limits2, 1);
    assert.strictEqual(deadline, toolEnded + limits2.deadlineMs);
    // The old wiring passed the base limits here, so the clamp landed 26 s in the past.
    assert.ok(nextDeadline(toolEnded, t0, limits2) < toolEnded);
    const snapshot = base({
      startedAt: t0,
      lastOutputAt: toolEnded,
      lastTurnAt: toolEnded - 14_000,
      deadlineAt: deadline,
      turns: 111,
      extensionsUsed: 1,
    });
    assert.strictEqual(evaluateGuards(toolEnded, snapshot, limits2).reason, null);
    // Past the 2× extension ceiling the hard cap still ends the run.
    assert.match(
      evaluateGuards(t0 + limits2.hardMs * 2, snapshot, limits2).reason ?? "",
      /hard limit reached/,
    );
  });

  it("resolveGuardLimits reads frontmatter values and falls back to defaults", () => {
    const defaults = resolveGuardLimits(baseAgent());
    assert.strictEqual(defaults.hardMs, GUARD_DEFAULTS.hardMs);
    assert.strictEqual(defaults.maxTurns, GUARD_DEFAULTS.maxTurns);
    assert.strictEqual(defaults.contextLimitPercent, GUARD_DEFAULTS.contextLimitPercent);

    const custom = resolveGuardLimits(baseAgent({ timeoutMs: 5_000, maxTurns: 7, contextLimitPercent: 0 }));
    assert.strictEqual(custom.hardMs, 5_000);
    assert.strictEqual(custom.maxTurns, 7);
    assert.strictEqual(custom.contextLimitPercent, 0);
    assert.strictEqual(defaults.maxExtensions, GUARD_DEFAULTS.maxExtensions);
    assert.strictEqual(defaults.extendGraceMs, GUARD_DEFAULTS.extendGraceMs);
    const customExt = resolveGuardLimits(baseAgent({ maxExtensions: 0, extendGraceMs: 120_000 }));
    assert.strictEqual(customExt.maxExtensions, 0);
    assert.strictEqual(customExt.extendGraceMs, 120_000);
  });

  it("formatDuration renders minutes and hours", () => {
    assert.strictEqual(formatDuration(0), "0s");
    assert.strictEqual(formatDuration(45_000), "45s");
    assert.strictEqual(formatDuration(723_000), "12m 03s");
    assert.strictEqual(formatDuration(3_900_000), "1h 05m");
    assert.strictEqual(formatDuration(300_000), "5m");
  });

  it("a run stopped by a guard keeps its partial output", () => {
    const result: SingleResult = {
      agent: "coder",
      agentSource: "builtin",
      task: "t",
      exitCode: 1,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Half of the work is done; the parser is rewritten." }],
        } as SingleResult["messages"][number],
      ],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 3 },
      stopReason: "toolUse",
      errorMessage: "Subagent stopped by guard: context at 41% of 200000 (limit 40%)",
      interrupted: { reason: "context at 41% of 200000 (limit 40%)", elapsedMs: 723_000 },
      transcriptPath: "C:/tmp/run.transcript.md",
    };
    assert.strictEqual(isFailedResult(result), true);
    const output = getResultOutput(result);
    assert.match(output, /stopped by guard: context at 41%/);
    assert.match(output, /12m 03s/);
    assert.match(output, /Half of the work is done/);
    assert.match(output, /run\.transcript\.md/);
    // A guard stop is deliberate: never respawn it.
    assert.strictEqual(shouldRetrySpawn(result), false);
  });
});


describe("sub-agents runner helpers", () => {
  it("isFailedResult detects non-zero exit", () => {
    const ok: SingleResult = {
      agent: "a",
      agentSource: "builtin",
      task: "t",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
    assert.strictEqual(isFailedResult(ok), false);
    assert.strictEqual(isFailedResult({ ...ok, exitCode: 1 }), true);
  });

  it("shouldRetrySpawn: only the hard list stops a respawn (resume keeps the child's work)", () => {
    const base: SingleResult = {
      agent: "a",
      agentSource: "builtin",
      task: "t",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      stopReason: "error",
    };
    // Unknown/unlisted transient strings retry — the router/upstream class.
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "Streaming response failed: [router_error] model upstream is unavailable" }), true);
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "Connection error." }), true);
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "529 overloaded_error: Overloaded" }), true);
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "500 Unknown Error" }), true);
    // A routing 403 is not an auth 403: the text decides, not the status code.
    assert.strictEqual(
      shouldRetrySpawn({ ...base, errorMessage: '403: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}' }),
      true,
    );
    // Deterministic failures stop: quota, money, auth, invalid request, overflow.
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "GoUsageLimitError" }), false);
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "HTTP 401: invalid api key" }), false);
    assert.strictEqual(
      shouldRetrySpawn({ ...base, errorMessage: '403 {"error":{"type":"permission_error","message":"You reached your weekly usage limit."}}' }),
      false,
    );
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "400 status code (no body)" }), false);
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "Subagent was aborted" }), false);
    assert.strictEqual(
      shouldRetrySpawn({ ...base, errorMessage: "Subagent killed by guard: timeout=600000ms, maxTurns=50" }),
      false,
    );
    assert.strictEqual(shouldRetrySpawn({ ...base, stopReason: "stop", errorMessage: undefined }), false);

    // A respawn resumes the same child session, so tool calls made before the
    // blip are never repeated — mutating work no longer blocks the retry.
    const writeCall: SingleResult["messages"][number] = {
      role: "assistant",
      content: [{ type: "toolCall", name: "write", arguments: {} }],
    } as SingleResult["messages"][number];
    assert.strictEqual(shouldRetrySpawn({ ...base, errorMessage: "fetch failed", messages: [writeCall] }), true);
  });

  it("a failed run's output carries the transcript path for orchestrator retry", () => {
    const result: SingleResult = {
      agent: "a",
      agentSource: "builtin",
      task: "t",
      exitCode: 1,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      stopReason: "error",
      errorMessage: "Streaming response failed: [router_error] model upstream is unavailable",
      transcriptPath: "C:/tmp/run.transcript.md",
    };
    const output = getResultOutput(result);
    assert.match(output, /router_error/);
    assert.match(output, /Transcript: C:\/tmp\/run\.transcript\.md/);
  });
});

describe("sub-agents parent prompt marker", () => {
  const role = "## Autonomy\nact.\n\n<!-- sub-agents -->\n\n## Style\nbrief.\n";

  it("detects the HTML comment marker", () => {
    assert.strictEqual(containsSubAgentsMarker(role), true);
    assert.strictEqual(containsSubAgentsMarker("no marker here"), false);
    assert.strictEqual(containsSubAgentsMarker("<!--  sub-agents  -->"), true);
  });

  it("replaces the marker with the section when enabled", () => {
    const out = applySubAgentsSection(role, true, "## Sub-agents\nSpawn when bounded.\n");
    assert.match(out, /## Autonomy/);
    assert.match(out, /## Sub-agents\nSpawn when bounded\./);
    assert.match(out, /## Style/);
    assert.doesNotMatch(out, /<!--\s*sub-agents\s*-->/);
  });

  it("strips the marker and extra blank lines when off", () => {
    const out = applySubAgentsSection(role, false, "## Sub-agents\nnope\n");
    assert.strictEqual(out, "## Autonomy\nact.\n\n## Style\nbrief.\n");
  });

  it("strips the marker when enabled but the section file is missing", () => {
    const out = applySubAgentsSection(role, true, null);
    assert.strictEqual(out, "## Autonomy\nact.\n\n## Style\nbrief.\n");
  });

  it("leaves the prompt unchanged when the marker is absent", () => {
    const text = "## Role\nplain\n";
    assert.strictEqual(applySubAgentsSection(text, true, "## Sub-agents\nx\n"), text);
    assert.strictEqual(applySubAgentsSection(text, false, null), text);
  });

  it("loads the parent section fragment from the roles dir", async () => {
    // The fragment lives at runtime (`~/.pi/agent/extensions/role-sw/roles`), not in this repo:
    // the case owns a throwaway roles dir so it does not depend on which roles exist.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-agents-roles-"));
    fs.writeFileSync(path.join(dir, "_Sub-agents.md"), "## Sub-agents\n\nthe user pays for itself\n");
    try {
      const section = await loadParentSection(dir);
      assert.ok(section);
      assert.match(section, /^## Sub-agents/m);
      assert.match(section, /pays for itself/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sub-agents resolveSubAgentsEnabled", () => {
  it("keeps an existing session state", () => {
    assert.deepStrictEqual(resolveSubAgentsEnabled({ enabled: true }, "new"), {
      enabled: true,
      persistDefault: false,
    });
    assert.deepStrictEqual(resolveSubAgentsEnabled({ enabled: false }, "startup"), {
      enabled: false,
      persistDefault: false,
    });
  });

  it("defaults /new with no state to OFF and asks to persist", () => {
    assert.deepStrictEqual(resolveSubAgentsEnabled(null, "new"), {
      enabled: false,
      persistDefault: true,
    });
  });

  it("keeps legacy ON when no state on resume/startup/reload/fork", () => {
    for (const reason of ["startup", "resume", "reload", "fork", undefined]) {
      assert.deepStrictEqual(resolveSubAgentsEnabled(null, reason), {
        enabled: true,
        persistDefault: false,
      });
    }
  });
});

describe("sub-agents transcript", () => {
  function result(over: Partial<SingleResult> = {}): SingleResult {
    return {
      agent: "coder",
      agentSource: "builtin",
      task: "t",
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I changed the parser." },
            { type: "toolCall", name: "edit", arguments: { path: "src/a.rs" } },
          ],
        } as SingleResult["messages"][number],
      ],
      stderr: "",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 10, turns: 4 },
      stopReason: "stop",
      ...over,
    };
  }

  it("keeps the whole brief — the parent's only on-disk copy of its own words", () => {
    const brief = `# Title\n\n${"x".repeat(6000)}\n`;
    const md = formatTranscript(result(), baseAgent({ name: "coder" }), brief, "C:/proj", 1000);
    assert.match(md, /^## Prompt \(brief\)$/m);
    assert.ok(md.includes("x".repeat(6000)));
    assert.match(md, /^`{3,}$/m);
  });

  it("names its sections so the brief's own headings cannot be mistaken for them", () => {
    const md = formatTranscript(result(), baseAgent(), "## Prompt (brief)\n## Messages", "C:/proj", 1000);
    assert.match(md, /^## Messages$/m);
    assert.match(md, /^## Final message$/m);
    assert.strictEqual(/^## Prompt \(brief\)$/gm.exec(md.split("\n").slice(0, 30).join("\n")) !== null, true);
  });

  it("writes a Stderr section only when the child wrote to stderr", () => {
    const clean = formatTranscript(result(), baseAgent(), "t", "C:/proj", 1000);
    assert.strictEqual(/^## Stderr$/m.test(clean), false);
    const noisy = formatTranscript(result({ stderr: "No API key found for infer-recon." }), baseAgent(), "t", "C:/proj", 1000);
    assert.match(noisy, /^## Stderr$/m);
    assert.match(noisy, /No API key found/);
  });

  it("records the attempt number and the guard reason", () => {
    const md = formatTranscript(
      result({ interrupted: { reason: "context at 41% (limit 40%)", elapsedMs: 1000 }, exitCode: 1 }),
      baseAgent(),
      "t",
      "C:/proj",
      12_000,
      2,
    );
    assert.match(md, /- \*\*Attempt:\*\* 2/);
    assert.match(md, /- \*\*Stopped by guard:\*\* context at 41%/);
  });
});
