// Request and event shapes verified against a live OpenCode v2.0.27 service.
import assert from "node:assert/strict";
import test from "node:test";
import {
  dynamicToolRow,
  forkBoundaryRetainingThrough,
  agentSessionOption,
  mapModel,
  metadataFileChanges,
  modelCatalogEntry,
  nativeSkillRoots,
  permissionReplyBody,
  promptBody,
  resolveModelVariant,
  sessionPermissionRules,
  sessionPermissionsRequest,
  sessionRenameRequest,
  shellExitCode,
  workspacePath,
} from "./support/host-api.js";

test("accept-edits asks for everything except reads, searches, and edits", () => {
  const rules = sessionPermissionRules({
    permissionMode: "accept-edits",
    disableSubagents: false,
  });
  assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "ask" });
  const effect = (action: string, resource = "*") =>
    // OpenCode evaluates rules in order and the last match wins.
    rules
      .filter(
        (rule) =>
          (rule.action === "*" || rule.action === action) &&
          (rule.resource === "*" || rule.resource === resource),
      )
      .at(-1)?.effect;
  assert.equal(effect("shell"), "ask");
  assert.equal(effect("webfetch"), "ask");
  assert.equal(effect("edit"), "allow");
  assert.equal(effect("read"), "allow");
  assert.equal(effect("read", "*.env"), "ask");
});

test("full mode allows everything and auto keeps OpenCode's agent rules", () => {
  assert.deepEqual(
    sessionPermissionRules({
      permissionMode: "full",
      disableSubagents: false,
    })[0],
    { action: "*", resource: "*", effect: "allow" },
  );
  assert.deepEqual(
    sessionPermissionRules({ permissionMode: "auto", disableSubagents: false }),
    [{ action: "bb_opencode2_*", resource: "*", effect: "deny" }],
  );
});

test("each session sees only its own BB tool server, and subagents are denied", () => {
  const rules = sessionPermissionRules({
    permissionMode: "accept-edits",
    disableSubagents: true,
    dynamicToolServer: "bb_opencode2_abc",
    dynamicToolNames: ["bb_echo"],
  });
  assert.deepEqual(rules.slice(-4), [
    { action: "bb_opencode2_*", resource: "*", effect: "deny" },
    { action: "bb_opencode2_abc_*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
  ]);
  // Without BB tools, other threads' servers are still hidden.
  assert.deepEqual(
    sessionPermissionRules({ permissionMode: "full", disableSubagents: false }),
    [
      { action: "*", resource: "*", effect: "allow" },
      { action: "bb_opencode2_*", resource: "*", effect: "deny" },
    ],
  );
});

test("session updates use PATCH /api/session/:id", () => {
  assert.deepEqual(sessionRenameRequest("ses_1", "New title"), {
    path: "/api/session/ses_1",
    init: { method: "PATCH", body: JSON.stringify({ title: "New title" }) },
  });
  assert.deepEqual(sessionPermissionsRequest("ses_1", []), {
    path: "/api/session/ses_1",
    init: { method: "PATCH", body: JSON.stringify({ permissions: [] }) },
  });
});

test("permission replies send `decision`, with a message when rejecting", () => {
  assert.deepEqual(permissionReplyBody("once"), { decision: "once" });
  assert.deepEqual(permissionReplyBody("always"), { decision: "always" });
  const reject = permissionReplyBody("reject");
  assert.equal(reject.decision, "reject");
  assert.match(reject.message ?? "", /denied/);
});

test("fork bodies use `before`, never the stripped `boundary` key", () => {
  const messages = [
    { id: "msg_u1", type: "user" },
    { id: "msg_a1", type: "assistant" },
    { id: "msg_u2", type: "user" },
  ];
  assert.deepEqual(forkBoundaryRetainingThrough(messages, "msg_u1"), {
    before: "msg_u2",
  });
  assert.deepEqual(forkBoundaryRetainingThrough(messages, "msg_u2"), {});
});

const model = (variants: string[], context?: number) => ({
  providerID: "opencode",
  id: "test-model",
  name: "Test Model",
  variants: variants.map((id) => ({ id })),
  ...(context ? { limit: { context } } : {}),
});

test("maps OpenCode variants to BB reasoning levels, including aliases", () => {
  const entry = modelCatalogEntry(
    model(["thinking", "minimal", "none", "max"], 200_000),
  );
  assert.deepEqual(
    [...entry.variants],
    [
      ["none", "none"],
      ["low", "minimal"],
      ["high", "thinking"],
      ["max", "max"],
    ],
  );
  assert.equal(entry.contextWindow, 200_000);
  // A native level wins over an alias.
  assert.equal(
    modelCatalogEntry(model(["low", "minimal"])).variants.get("low"),
    "low",
  );
});

test("never sends a variant the model does not have", () => {
  const withVariants = modelCatalogEntry(model(["minimal", "high"]));
  const ref = { providerID: "opencode", id: "test-model" };
  assert.deepEqual(
    resolveModelVariant({ ...ref, variant: "low" }, withVariants),
    { ...ref, variant: "minimal" },
  );
  assert.deepEqual(
    resolveModelVariant({ ...ref, variant: "medium" }, withVariants),
    ref,
  );
  assert.deepEqual(
    resolveModelVariant(
      { ...ref, variant: "medium" },
      modelCatalogEntry(model([])),
    ),
    ref,
  );
});

test("defaults to medium effort and marks only the chosen default model", () => {
  const mapped = mapModel(model(["none", "low", "medium", "high"]), true);
  assert.equal(mapped.defaultReasoningEffort, "medium");
  assert.equal(mapped.isDefault, true);
  assert.equal(mapModel(model([]), false).isDefault, false);
  assert.deepEqual(mapModel(model([]), false).supportedReasoningEfforts, [
    { reasoningEffort: "medium", description: "Default" },
  ]);
});

test("reads shell exit codes from v2 tool metadata or content", () => {
  assert.equal(
    shellExitCode({ metadata: { status: "completed", exit: 3 } }),
    3,
  );
  assert.equal(
    shellExitCode({
      content: [
        { type: "text", text: "tick\n" },
        { type: "text", text: "Exited with code 2" },
      ],
    }),
    2,
  );
  assert.equal(shellExitCode({ metadata: { status: "completed" } }), undefined);
});

test("builds file-change rows from OpenCode's edit metadata patches", () => {
  assert.deepEqual(
    metadataFileChanges(
      {
        files: [
          {
            file: "src/a.ts",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            status: "modified",
          },
          { file: "new.ts", status: "added" },
          { file: "old.ts", status: "deleted" },
          { status: "modified" },
        ],
      },
      "/repo",
    ),
    [
      { path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "new.ts", kind: "add" },
      { path: "old.ts", kind: "delete" },
    ],
  );
  assert.deepEqual(metadataFileChanges({ truncated: false }, "/repo"), []);
  assert.deepEqual(
    metadataFileChanges(
      {
        files: [
          {
            file: "/repo/a.ts",
            patch: "--- /repo/a.ts\n+++ /repo/a.ts\n",
            status: "modified",
          },
        ],
      },
      "/repo",
    ),
    [{ path: "a.ts", kind: "update", diff: "--- a.ts\n+++ a.ts\n" }],
  );
});

test("reports touched files relative to the workspace", () => {
  assert.equal(workspacePath("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(workspacePath("/repo", "src/a.ts"), "src/a.ts");
  assert.equal(workspacePath("/repo", "/elsewhere/b.ts"), "/elsewhere/b.ts");
});

test("renders BB dynamic tool calls as the BB tool", () => {
  const presentation = {
    icon: { glyph: "Globe" },
    label: { pending: "Opening page", completed: "Opened page" },
  };
  const tools = [
    {
      name: "browser_open",
      description: "Open a page",
      inputSchema: {},
      presentation,
    },
    { name: "bb_echo", description: "Echo", inputSchema: {} },
  ];
  const row = dynamicToolRow(
    "bb_opencode2_abc",
    tools,
    "bb_opencode2_abc_browser_open",
    {
      url: "https://example.com",
    },
  );
  assert.equal(row?.item.tool, "browser_open");
  assert.deepEqual(row?.presentation, presentation);
  const echo = dynamicToolRow(
    "bb_opencode2_abc",
    tools,
    "bb_opencode2_abc_bb_echo",
    { text: "ping" },
  );
  assert.equal(echo?.item.tool, "bb_echo");
  assert.equal(echo?.presentation.title, "ping");
  assert.equal(
    dynamicToolRow("bb_opencode2_abc", tools, "shell", {}),
    undefined,
  );
});

test("derives BB skill roots from the skills OpenCode discovered", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(join(tmpdir(), "oc-skills-"));
  const home = join(base, "home", ".agents", "skills");
  const repo = join(base, "repo");
  const project = join(repo, ".opencode", "skills");
  for (const dir of [
    join(home, "unslop"),
    join(home, "grill-me"),
    join(project, "local"),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
  }
  assert.deepEqual(
    nativeSkillRoots(
      [
        { path: "/builtin/opencode.md" },
        { path: join(home, "unslop", "SKILL.md") },
        { path: join(home, "grill-me", "SKILL.md") },
        { path: join(project, "local", "SKILL.md") },
        { path: join(base, "missing", "gone", "SKILL.md") },
        {},
      ],
      repo,
    ),
    [
      { path: home, origin: "user", shape: "skills" },
      { path: project, origin: "project", shape: "skills" },
    ],
  );
});

test("forwards native OpenCode skill mentions, not only BB-configured ones", () => {
  const body = promptBody(
    [
      {
        type: "text",
        text: "/unslop this README",
        mentions: [
          {
            start: 0,
            end: 7,
            resource: {
              kind: "command",
              source: "skill",
              trigger: "/",
              name: "unslop",
            },
          },
        ],
      },
    ],
    {
      configuredSkillNames: new Set(["bb-cli"]),
      nativeSkillNames: new Set(["unslop"]),
    },
  );
  assert.deepEqual(body.skills, [
    { id: "unslop", mention: { start: 0, end: 7, text: "/unslop" } },
  ]);
});

test("offers an agent session option whenever OpenCode has a primary agent", () => {
  assert.equal(agentSessionOption([]), undefined);
  assert.deepEqual(
    agentSessionOption([{ id: "build" }, { id: "plan" }])?.values,
    [
      { id: "build", label: "build" },
      { id: "plan", label: "plan" },
    ],
  );
  assert.deepEqual(
    agentSessionOption([
      { id: "build" },
      { id: "plan" },
      { id: "reviewer", description: "Reviews code" },
    ]),
    {
      type: "select",
      id: "agent",
      label: "Agent",
      description: "OpenCode primary agent",
      value: "build",
      values: [
        { id: "build", label: "build" },
        { id: "plan", label: "plan" },
        { id: "reviewer", label: "reviewer", description: "Reviews code" },
      ],
    },
  );
  assert.equal(
    agentSessionOption([{ id: "build" }, { id: "reviewer" }], "reviewer")
      ?.value,
    "reviewer",
  );
  // A choice that is no longer offered falls back to the default.
  assert.equal(
    agentSessionOption([{ id: "build" }, { id: "reviewer" }], "gone")?.value,
    "build",
  );
  const option = agentSessionOption([{ id: "build" }, { id: "reviewer" }]);
  assert.ok(option);
  assert.deepEqual(
    mapModel({ providerID: "p", id: "m" }, true, [option]).sessionOptions,
    [option],
  );
  assert.equal(
    "sessionOptions" in mapModel({ providerID: "p", id: "m" }, true),
    false,
  );
});
