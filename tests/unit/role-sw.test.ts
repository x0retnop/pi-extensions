import assert from "node:assert";
import { describe, it } from "node:test";
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  modelRoleMapKey,
  normalizeRoleName,
  resolveRoleForModel,
  pickRoleForStartup,
  findSavedRole,
} from "../../role-sw/config.js";
import {
  ROLES_DIR,
  getAvailableRoles,
  isSelectableRoleFile,
  resolveIncludes,
  resolveRole,
  resolveRoleFileIn,
  roleFamily,
  readRole,
  stripFrontmatter,
} from "../../role-sw/roles.js";
import {
  SENTINEL_ALARM,
  composeInteractivePrompt,
} from "../../role-sw/sentinel.js";

function fakeModel(provider: string, id: string) {
  return { provider, id } as any;
}

// Role files live and change at runtime (`~/.pi/agent/extensions/role-sw/roles`) — this repo only
// deploys the extension — so the cases below seed their own fixtures into the dev roles dir (ignored
// by git) instead of relying on roles being present.
mkdirSync(ROLES_DIR, { recursive: true });

describe("role-sw modelRoleMapKey / resolveRoleForModel", () => {
  it("builds provider::modelId keys", () => {
    assert.strictEqual(
      modelRoleMapKey(fakeModel("opencode-go", "deepseek-v4-flash")),
      "opencode-go::deepseek-v4-flash",
    );
  });

  it("returns undefined for missing model", () => {
    assert.strictEqual(modelRoleMapKey(undefined), undefined);
    assert.strictEqual(resolveRoleForModel(undefined, { a: "b" }), undefined);
  });

  it("resolves by full key, then bare model id fallback", () => {
    const map = {
      "opencode-go::deepseek-v4-flash": "sub-ds-v4-flash",
      "kimi-k2.7-code": "base-win-v18",
    };
    assert.strictEqual(
      resolveRoleForModel(fakeModel("opencode-go", "deepseek-v4-flash"), map),
      "sub-ds-v4-flash",
    );
    assert.strictEqual(
      resolveRoleForModel(fakeModel("kimi", "kimi-k2.7-code"), map),
      "base-win-v18",
    );
    assert.strictEqual(
      resolveRoleForModel(fakeModel("other", "unknown"), map),
      undefined,
    );
  });

  it("pickRoleForStartup prefers the saved session role over the model map", () => {
    const settings = {
      defaultMode: "fixed" as const,
      fixedRole: "kimi",
      modelRoleMap: { "opencode-go::deepseek-v4-flash": "base-v7-ds-v4-flash" },
    };
    const res = pickRoleForStartup({
      savedRole: "test",
      available: ["test", "base-v7-ds-v4-flash", "kimi"],
      settings,
      model: fakeModel("opencode-go", "deepseek-v4-flash"),
      defaultRole: "kimi",
    });
    assert.deepStrictEqual(res, { role: "test", fromSession: true });
  });

  it("pickRoleForStartup applies the model map when no role is saved", () => {
    const settings = {
      defaultMode: "fixed" as const,
      fixedRole: "kimi",
      modelRoleMap: { "opencode-go::deepseek-v4-flash": "base-v7-ds-v4-flash" },
    };
    const res = pickRoleForStartup({
      savedRole: null,
      available: ["test", "base-v7-ds-v4-flash", "kimi"],
      settings,
      model: fakeModel("opencode-go", "deepseek-v4-flash"),
      defaultRole: "kimi",
    });
    assert.deepStrictEqual(res, { role: "base-v7-ds-v4-flash", fromSession: false });
  });

  it("pickRoleForStartup falls back to default when saved role was deleted", () => {
    const settings = {
      defaultMode: "fixed" as const,
      fixedRole: "kimi",
      modelRoleMap: { "opencode-go::deepseek-v4-flash": "base-v7-ds-v4-flash" },
    };
    // Saved role "test" no longer exists on disk → model map applies.
    const res = pickRoleForStartup({
      savedRole: "test",
      available: ["base-v7-ds-v4-flash", "kimi"],
      settings,
      model: fakeModel("opencode-go", "deepseek-v4-flash"),
      defaultRole: "kimi",
    });
    assert.deepStrictEqual(res, { role: "base-v7-ds-v4-flash", fromSession: false });
  });

  it("pickRoleForStartup falls back to default for unmapped models", () => {
    const settings = {
      defaultMode: "fixed" as const,
      fixedRole: "kimi",
      modelRoleMap: {},
    };
    const res = pickRoleForStartup({
      savedRole: null,
      available: ["kimi"],
      settings,
      model: fakeModel("other", "unknown"),
      defaultRole: "kimi",
    });
    assert.deepStrictEqual(res, { role: "kimi", fromSession: false });
  });

  it("findSavedRole returns the newest role-switcher entry in a branch", () => {
    const branch = [
      { type: "text" },
      { type: "custom", customType: "role-switcher", data: { role: "old" } },
      { type: "text" },
      { type: "custom", customType: "role-switcher", data: { role: "new" } },
    ];
    assert.strictEqual(findSavedRole(branch), "new");
  });

  it("findSavedRole returns null when the branch has no role record", () => {
    assert.strictEqual(findSavedRole([{ type: "text" }]), null);
    assert.strictEqual(findSavedRole([]), null);
  });

  it("findSavedRole ignores other custom entry types and missing role data", () => {
    const branch = [
      { type: "custom", customType: "model-manager-state", data: { updatedAt: 1 } },
      { type: "custom", customType: "role-switcher", data: {} },
    ];
    assert.strictEqual(findSavedRole(branch), null);
  });
});

describe("role-sw role aliases (versioned role names)", () => {
  it("normalizeRoleName maps a versioned name to its family", () => {
    assert.strictEqual(normalizeRoleName("agent-core-v3"), "agent-core");
    assert.strictEqual(normalizeRoleName("agent-core-v3.md"), "agent-core");
    assert.strictEqual(normalizeRoleName(" chat-v12 "), "chat");
    assert.strictEqual(normalizeRoleName("sub-default"), "sub-default");
    assert.strictEqual(normalizeRoleName("sub-ds-v4-flash"), "sub-ds-v4-flash");
  });

  it("pickRoleForStartup follows the bump for an old session entry", () => {
    const settings = { defaultMode: "fixed" as const, fixedRole: "", modelRoleMap: {} };
    const res = pickRoleForStartup({
      savedRole: "agent-core-v3",
      available: ["agent-core", "chat"],
      settings,
      model: fakeModel("xai", "grok-4.6"),
      defaultRole: "chat",
    });
    assert.deepStrictEqual(res, { role: "agent-core", fromSession: true });
  });

  it("pickRoleForStartup normalizes a versioned model-map entry", () => {
    const settings = {
      defaultMode: "fixed" as const,
      fixedRole: "",
      modelRoleMap: { "xai::grok-4.6": "agent-core-v3" },
    };
    const res = pickRoleForStartup({
      savedRole: null,
      available: ["agent-core", "chat"],
      settings,
      model: fakeModel("xai", "grok-4.6"),
      defaultRole: "chat",
    });
    assert.deepStrictEqual(res, { role: "agent-core", fromSession: false });
  });

  it("pickRoleForStartup falls through when the whole family is gone", () => {
    const settings = {
      defaultMode: "fixed" as const,
      fixedRole: "",
      modelRoleMap: { "xai::grok-4.6": "agent-core-v3" },
    };
    const res = pickRoleForStartup({
      savedRole: "agent-core-v9",
      available: ["chat"],
      settings,
      model: fakeModel("xai", "grok-4.6"),
      defaultRole: "chat",
    });
    assert.deepStrictEqual(res, { role: "chat", fromSession: false });
  });
});

describe("role-sw roles directory", () => {
  const seeded = ["sub-default", "agent-core-v2", "agent-core-v3", "chat-v5", "_Sub-agents", "README"];

  function seed(): void {
    mkdirSync(ROLES_DIR, { recursive: true });
    writeFileSync(path.join(ROLES_DIR, "sub-default.md"), "You are a sub-agent.\n", "utf-8");
    writeFileSync(path.join(ROLES_DIR, "agent-core-v2.md"), "old core body\n", "utf-8");
    writeFileSync(path.join(ROLES_DIR, "agent-core-v3.md"), "newer core body\n", "utf-8");
    writeFileSync(path.join(ROLES_DIR, "chat-v5.md"), "chat body\n", "utf-8");
    writeFileSync(path.join(ROLES_DIR, "_Sub-agents.md"), "## Sub-agents\n", "utf-8");
    writeFileSync(path.join(ROLES_DIR, "README.md"), "# roles\n", "utf-8");
    writeFileSync(path.join(ROLES_DIR, "notes.txt"), "not a role\n", "utf-8");
  }

  function cleanup(): void {
    for (const name of seeded) {
      const p = path.join(ROLES_DIR, `${name}.md`);
      if (existsSync(p)) unlinkSync(p);
    }
    const txt = path.join(ROLES_DIR, "notes.txt");
    if (existsSync(txt)) unlinkSync(txt);
  }

  it("lists one entry per role family, skipping README and _fragments", async () => {
    seed();
    try {
      const roles = await getAvailableRoles();
      assert.ok(roles.includes("sub-default"));
      assert.ok(roles.includes("agent-core"), "family alias, not the versioned file");
      assert.ok(roles.includes("chat"));
      assert.ok(!roles.includes("agent-core-v3"), "versions collapse into the family");
      assert.ok(!roles.some((r) => r.toLowerCase() === "readme"));
      assert.ok(!roles.some((r) => r.startsWith("_") || r.toLowerCase() === "sub-agents"));
      assert.ok(!roles.includes("notes"), "non-markdown files are not roles");
    } finally {
      cleanup();
    }
  });

  it("isSelectableRoleFile skips README and underscore fragments", () => {
    assert.strictEqual(isSelectableRoleFile("agent-core-v2.md"), true);
    assert.strictEqual(isSelectableRoleFile("README.md"), false);
    assert.strictEqual(isSelectableRoleFile("readme.md"), false);
    assert.strictEqual(isSelectableRoleFile("_Sub-agents.md"), false);
    assert.strictEqual(isSelectableRoleFile("_base.md"), false);
    assert.strictEqual(isSelectableRoleFile("notes.txt"), false);
  });

  it("roleFamily strips only a trailing -v<digits> suffix", () => {
    assert.strictEqual(roleFamily("agent-core-v3"), "agent-core");
    assert.strictEqual(roleFamily("agent-core-v10"), "agent-core");
    assert.strictEqual(roleFamily("chat-v1"), "chat");
    // Not a version suffix — must stay intact.
    assert.strictEqual(roleFamily("sub-ds-v4-flash"), "sub-ds-v4-flash");
    assert.strictEqual(roleFamily("sub-default"), "sub-default");
    assert.strictEqual(roleFamily("blank"), "blank");
  });

  it("readRole loads a role body from disk", async () => {
    mkdirSync(ROLES_DIR, { recursive: true });
    const fixture = path.join(ROLES_DIR, `__test_body_${process.pid}.md`);
    writeFileSync(fixture, "You are a technical sub-agent for testing.\n", "utf-8");
    try {
      const body = await readRole(fixture);
      assert.ok(body && body.length > 20);
    } finally {
      unlinkSync(fixture);
    }
  });

  it("readRole strips YAML front-matter from role files", async () => {
    // No repo role carries front-matter anymore; use a temp fixture so the
    // test does not depend on which roles exist.
    const fixture = path.join(ROLES_DIR, "_frontmatter-fixture.tmp.md");
    writeFileSync(
      fixture,
      "---\nname: sub-fixture\ndescription: test fixture\n---\nYou are a technical sub-agent for testing.\n",
    );
    try {
      const body = await readRole(fixture);
      assert.ok(body);
      assert.doesNotMatch(body, /^---\s*$/m);
      assert.doesNotMatch(body, /^name:\s*sub-fixture$/m);
      assert.doesNotMatch(body, /^description:/m);
      // The real content survives.
      assert.match(body, /You are a technical sub-agent/);
    } finally {
      unlinkSync(fixture);
    }
  });

  it("stripFrontmatter only removes a leading YAML block", () => {
    assert.strictEqual(stripFrontmatter("plain body"), "plain body");
    assert.strictEqual(
      stripFrontmatter("---\nname: x\n---\nbody"),
      "body",
    );
    assert.strictEqual(
      stripFrontmatter("---\nname: x\n---\nbody\n---\nnot frontmatter"),
      "body\n---\nnot frontmatter",
    );
  });
});

describe("role-sw family resolution (versioned role files)", () => {
  const family = `zzfam${process.pid}`;
  const plain = `zzplain${process.pid}`;
  const versionFiles = [1, 2, 10].map((v) => path.join(ROLES_DIR, `${family}-v${v}.md`));
  const plainPath = path.join(ROLES_DIR, `${plain}.md`);
  const plainVersionPath = path.join(ROLES_DIR, `${plain}-v2.md`);

  function cleanup(): void {
    for (const p of [...versionFiles, plainPath, plainVersionPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }

  function writeVersioned(): void {
    versionFiles.forEach((p, i) => writeFileSync(p, `BODY ${i}\n`, "utf-8"));
  }

  it("resolves an alias to the highest version, numerically", () => {
    cleanup();
    try {
      writeVersioned();
      const ref = resolveRole(family);
      assert.ok(ref);
      assert.strictEqual(ref.name, `${family}-v10`);
      assert.strictEqual(ref.alias, family);
      assert.strictEqual(ref.path, path.join(ROLES_DIR, `${family}-v10.md`));
    } finally {
      cleanup();
    }
  });

  it("a concrete version is not pinned — it follows the newest sibling", () => {
    cleanup();
    try {
      writeVersioned();
      assert.strictEqual(resolveRole(`${family}-v1`)?.name, `${family}-v10`);
      assert.strictEqual(resolveRole(`${family}-v2`)?.alias, family);
    } finally {
      cleanup();
    }
  });

  it("lists one alias per family and hides versioned files", async () => {
    cleanup();
    try {
      writeVersioned();
      const roles = await getAvailableRoles();
      assert.ok(roles.includes(family));
      assert.ok(!roles.includes(`${family}-v1`));
      assert.ok(!roles.includes(`${family}-v10`));
    } finally {
      cleanup();
    }
  });

  it("an exact unversioned file wins over versioned siblings", () => {
    cleanup();
    try {
      writeFileSync(plainPath, "PLAIN\n", "utf-8");
      writeFileSync(plainVersionPath, "VERSIONED\n", "utf-8");
      assert.strictEqual(resolveRole(plain)?.name, plain);
      // A versioned request for the same family still follows the newest version.
      assert.strictEqual(resolveRole(`${plain}-v2`)?.name, `${plain}-v2`);
    } finally {
      cleanup();
    }
  });

  it("returns null for unknown names and never resolves _fragments", () => {
    assert.strictEqual(resolveRole(`zzmissing${process.pid}`), null);
    assert.strictEqual(resolveRole(""), null);
    assert.strictEqual(resolveRoleFileIn(ROLES_DIR, "_Sub-agents"), null);
  });
});

describe("role-sw resolveIncludes", () => {
  const fragName = `__test_include_frag_${process.pid}.md`;
  const parentName = `__test_include_parent_${process.pid}.md`;
  const circA = `__test_circ_a_${process.pid}.md`;
  const circB = `__test_circ_b_${process.pid}.md`;
  const fragPath = path.join(ROLES_DIR, fragName);
  const parentPath = path.join(ROLES_DIR, parentName);
  const circAPath = path.join(ROLES_DIR, circA);
  const circBPath = path.join(ROLES_DIR, circB);

  function cleanup() {
    for (const p of [fragPath, parentPath, circAPath, circBPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }

  it("expands {{include:file}} from roles dir", async () => {
    cleanup();
    try {
      writeFileSync(fragPath, "FRAGMENT_BODY\n", "utf-8");
      writeFileSync(parentPath, `before\n{{include: ${fragName} }}\nafter\n`, "utf-8");
      const text = await resolveIncludes(await (await import("node:fs/promises")).readFile(parentPath, "utf-8"));
      assert.match(text, /FRAGMENT_BODY/);
      assert.match(text, /before/);
      assert.match(text, /after/);
      assert.doesNotMatch(text, /\{\{include/);
    } finally {
      cleanup();
    }
  });

  it("marks missing includes without throwing", async () => {
    const text = await resolveIncludes("x\n{{include: __no_such_include_zzz.md }}\ny\n");
    assert.match(text, /missing include: __no_such_include_zzz\.md/);
    assert.match(text, /^x$/m);
    assert.match(text, /^y$/m);
  });

  it("skips circular includes", async () => {
    cleanup();
    try {
      writeFileSync(circAPath, `A\n{{include: ${circB} }}\n`, "utf-8");
      writeFileSync(circBPath, `B\n{{include: ${circA} }}\n`, "utf-8");
      const text = await resolveIncludes(
        await (await import("node:fs/promises")).readFile(circAPath, "utf-8"),
      );
      assert.match(text, /circular include skipped/);
      assert.match(text, /A/);
      assert.match(text, /B/);
    } finally {
      cleanup();
    }
  });

  it("expands the same include marker appearing twice", async () => {
    cleanup();
    try {
      writeFileSync(fragPath, "FRAGMENT_BODY\n", "utf-8");
      const parentPath = path.join(ROLES_DIR, parentName);
      writeFileSync(
        parentPath,
        `{{include: ${fragName} }}\n{{include: ${fragName} }}\n`,
        "utf-8",
      );
      const text = await resolveIncludes(
        await (await import("node:fs/promises")).readFile(parentPath, "utf-8"),
      );
      assert.strictEqual(text.match(/FRAGMENT_BODY/g)?.length, 2);
    } finally {
      cleanup();
    }
  });

  it("preserves $ special characters inside fragment content", async () => {
    cleanup();
    try {
      writeFileSync(fragPath, "cost is $& and $1 and $$ literal\n", "utf-8");
      const text = await resolveIncludes(`before\n{{include: ${fragName} }}\nafter\n`);
      assert.match(text, /cost is \$& and \$1 and \$\$ literal/);
    } finally {
      cleanup();
    }
  });

  it("strips front-matter from included fragments", async () => {
    cleanup();
    try {
      writeFileSync(
        fragPath,
        "---\nname: model-x\n---\nFRAGMENT_WITH_FM_BODY\n",
        "utf-8",
      );
      const text = await resolveIncludes(`base\n{{include: ${fragName} }}\n`);
      assert.doesNotMatch(text, /^---\s*$/m);
      assert.doesNotMatch(text, /^name:/m);
      assert.match(text, /FRAGMENT_WITH_FM_BODY/);
    } finally {
      cleanup();
    }
  });

  it("readRole resolves nested includes through readFileCached", async () => {
    const frag2Name = `__test_include_frag2_${process.pid}.md`;
    const frag2Path = path.join(ROLES_DIR, frag2Name);
    cleanup();
    try {
      writeFileSync(frag2Path, "---\nname: model-y\n---\nLEAF_BODY\n", "utf-8");
      writeFileSync(fragPath, `mid\n{{include: ${frag2Name} }}\n`, "utf-8");
      writeFileSync(
        path.join(ROLES_DIR, parentName),
        "---\nname: base\n---\nHEADER\n{{include: " + fragName + " }}\nFOOTER\n",
        "utf-8",
      );
      const body = await readRole(path.join(ROLES_DIR, parentName));
      assert.ok(body);
      // Front-matter stripped at every level.
      assert.doesNotMatch(body, /^---\s*$/m);
      assert.doesNotMatch(body, /^name:/m);
      // Parent content around the marker.
      assert.match(body, /HEADER/);
      assert.match(body, /FOOTER/);
      // Nested fragment content.
      assert.match(body, /mid/);
      assert.match(body, /LEAF_BODY/);
      // No leftover markers.
      assert.doesNotMatch(body, /\{\{include/);
    } finally {
      cleanup();
      if (existsSync(frag2Path)) unlinkSync(frag2Path);
    }
  });
});

describe("role-sw sentinel / composeInteractivePrompt", () => {
  it("keeps role-sw/SYSTEM.md identical to SENTINEL_ALARM", () => {
    const onDisk = readFileSync(path.join(path.dirname(ROLES_DIR), "SYSTEM.md"), "utf-8").trim();
    assert.strictEqual(onDisk, SENTINEL_ALARM);
  });

  it("composeInteractivePrompt puts role first and strips the current canary", () => {
    const base = [
      SENTINEL_ALARM,
      "",
      "<project_context>",
      "Be concise.",
      "</project_context>",
      "Current working directory: C:/proj",
      "Current date: 2026-08-17",
    ].join("\n");
    const out = composeInteractivePrompt("## Role\nDo the work.", base);
    assert.ok(out.startsWith("## Role\nDo the work."));
    assert.doesNotMatch(out, /ROLE_SW_REQUIRED/);
    assert.doesNotMatch(out, /RUNTIME BROKEN/);
    assert.match(out, /<project_context>/);
    assert.match(out, /Current working directory: C:\/proj/);
    assert.match(out, /Current date: 2026-08-17/);
  });

  it("composeInteractivePrompt strips the legacy sentinel box", () => {
    const base = [
      "SENTINEL — this block is NOT your system prompt.",
      "",
      "Ignore this if a role is present.",
      "┌─────────────────────────────────────────┐",
      "│  🚨 CRITICAL: SYSTEM PROMPT CORRUPTED   │",
      "└─────────────────────────────────────────┘",
      "",
      "Current working directory: C:/proj",
    ].join("\n");
    const out = composeInteractivePrompt("## Role\nX", base);
    assert.doesNotMatch(out, /SENTINEL/);
    assert.doesNotMatch(out, /CRITICAL/);
    assert.match(out, /Current working directory: C:\/proj/);
  });

  it("missing or empty role returns alarm only — no AGENTS.md leftover", () => {
    const base = `${SENTINEL_ALARM}\n\n<project_context>\nsecret project rules\n</project_context>\nCurrent working directory: C:/proj`;
    assert.strictEqual(composeInteractivePrompt(null, base), SENTINEL_ALARM);
    assert.strictEqual(composeInteractivePrompt("   ", base), SENTINEL_ALARM);
    assert.doesNotMatch(composeInteractivePrompt(null, base), /secret project rules/);
  });

  it("composeInteractivePrompt keeps a base that has no canary", () => {
    const out = composeInteractivePrompt("## Role\nX", "Current working directory: C:/proj");
    assert.strictEqual(out, "## Role\nX\n\nCurrent working directory: C:/proj");
  });
});
