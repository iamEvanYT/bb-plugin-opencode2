import assert from "node:assert/strict";
import test from "node:test";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { OpenCodeEventRouter } from "./support/host-api.js";
import type {
  ActiveTurn,
  OpenCodeRecord,
  SessionState,
} from "../src/host/types.ts";

test("translates current OpenCode v2 text, reasoning, tool, and terminal events", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "oc-session",
    cwd: process.cwd(),
    disableSubagents: false,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
  };
  const sessionLookup = new Map([[session.providerThreadId, session]]);
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    sessionLookup,
  );
  const event = (type: string, data: OpenCodeRecord) =>
    router.handleEvent({
      type,
      data: { sessionID: session.providerThreadId, ...data },
    });

  await event("session.text.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
  });
  await event("session.text.delta", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    delta: "Hello",
  });
  await event("session.text.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    text: "Hello",
  });
  await event("session.text.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 1,
  });
  await event("session.text.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 1,
    text: "Again",
  });
  await event("session.reasoning.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    state: {},
  });
  await event("session.reasoning.delta", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    delta: "Think",
  });
  await event("session.reasoning.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    text: "Think",
    state: {},
  });
  await event("session.tool.input.started", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    name: "bash",
  });
  await event("session.tool.input.ended", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    text: JSON.stringify({ command: "printf ok" }),
  });
  await event("session.tool.called", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    input: { command: "printf ok" },
    executed: true,
    state: {},
  });
  await event("session.tool.success", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    content: [{ type: "text", text: "ok" }],
    metadata: {},
  });
  await event("session.step.ended", {
    assistantMessageID: "msg-assistant",
    finish: "stop",
    tokens: {
      input: 3,
      output: 2,
      reasoning: 1,
      cache: { read: 4, write: 5 },
    },
  });
  // OpenCode follows each step with the session's cumulative totals.
  await event("session.usage.updated", {
    cost: 0,
    tokens: {
      input: 30,
      output: 20,
      reasoning: 10,
      cache: { read: 40, write: 50 },
    },
  });
  await event("session.execution.succeeded", {});

  const openedKeys = emitted
    .filter((delta) => delta.kind === "item.open")
    .map((delta) => delta.key as { providerItemId: string; channel: string });
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "text:msg-assistant:0" &&
        key.channel === "agentMessage",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "text:msg-assistant:1" &&
        key.channel === "agentMessage",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "reasoning:msg-assistant:0" &&
        key.channel === "reasoningText",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) => key.providerItemId === "tool-1" && key.channel === "tool",
    ),
  );
  assert.equal(
    new Set(openedKeys.map((key) => JSON.stringify(key))).size,
    openedKeys.length,
  );

  const usage = emitted.find((delta) => delta.kind === "usage");
  assert.equal(usage?.last.totalTokens, 15);
  assert.equal(usage?.total.totalTokens, 150);
  assert.equal(usage?.modelContextWindow, 1000);
  const context = emitted.find((delta) => delta.kind === "contextWindow");
  assert.equal(context?.used, 15);
  assert.equal(context?.size, 1000);
  assert.equal(session.active, undefined);
  assert.equal(emitted.at(-1)?.kind, "turn.boundary");
  assert.equal(emitted.at(-1)?.status, "completed");
});

test("nests a native subagent's work under its delegation row", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_parent",
    cwd: process.cwd(),
    disableSubagents: false,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[session.providerThreadId, session]]),
  );
  const event = (sessionID: string, type: string, data: OpenCodeRecord) =>
    router.handleEvent({ type, data: { sessionID, ...data } });

  await event("ses_parent", "session.tool.input.started", {
    id: "call_sub",
    name: "subagent",
  });
  await event("ses_parent", "session.tool.called", {
    id: "call_sub",
    input: { agent: "explore", description: "List files", prompt: "ls" },
  });
  await event("ses_parent", "session.tool.progress", {
    id: "call_sub",
    metadata: { sessionID: "ses_child", status: "running" },
  });
  await event("ses_child", "session.tool.input.started", {
    id: "call_child",
    name: "read",
  });
  await event("ses_child", "session.tool.called", {
    id: "call_child",
    input: { path: "package.json" },
  });
  await event("ses_child", "session.tool.success", {
    id: "call_child",
    content: [{ type: "text", text: "{}" }],
  });
  // The child's own lifecycle must not settle the parent turn.
  await event("ses_child", "session.execution.succeeded", {});
  assert.equal(session.active, active);
  await event("ses_parent", "session.tool.success", {
    id: "call_sub",
    content: [
      {
        type: "text",
        text: '<subagent sessionID="ses_child" state="completed">\nOne file.\n</subagent>',
      },
    ],
    metadata: { sessionID: "ses_child", status: "completed" },
  });

  const delegationOpen = emitted.find(
    (delta) => delta.kind === "item.open" && delta.item.type === "delegation",
  );
  assert.equal(delegationOpen?.item.label, "explore: List files");
  assert.equal(delegationOpen?.key.parentRef, undefined);
  const childRows = emitted.filter(
    (delta) => delta.key?.providerItemId === "call_child",
  );
  assert.equal(childRows.length, 2);
  for (const delta of childRows) assert.equal(delta.key.parentRef, "call_sub");
  const delegationClose = emitted.find(
    (delta) => delta.kind === "item.close" && delta.item.type === "delegation",
  );
  assert.equal(delegationClose?.status, "completed");
  assert.equal(delegationClose?.item.childRef, "ses_child");
  assert.equal(delegationClose?.item.summary, "One file.");

  // Child events after the delegation's turn ended are dropped.
  router.finish(session, "completed");
  const count = emitted.length;
  await event("ses_child", "session.text.started", {
    assistantMessageID: "m",
    ordinal: 0,
  });
  assert.equal(emitted.length, count);
});

test("emits the turn's file patches as turn.diff before the boundary", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_1",
    cwd: "/repo",
    disableSubagents: true,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[session.providerThreadId, session]]),
  );
  const event = (type: string, data: OpenCodeRecord) =>
    router.handleEvent({ type, data: { sessionID: "ses_1", ...data } });
  const patch = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-two\n+TWO\n";
  await event("session.tool.input.started", { id: "call_edit", name: "edit" });
  await event("session.tool.called", {
    id: "call_edit",
    input: { path: "a.txt", oldString: "two", newString: "TWO" },
  });
  await event("session.tool.success", {
    id: "call_edit",
    content: [{ type: "text", text: "Edited a.txt" }],
    metadata: { files: [{ file: "a.txt", patch, status: "modified" }] },
  });
  await event("session.execution.succeeded", {});
  const kinds = emitted.map((delta) => delta.kind);
  const diffIndex = kinds.indexOf("turn.diff");
  assert.ok(diffIndex >= 0 && diffIndex < kinds.indexOf("turn.boundary"));
  assert.equal(emitted[diffIndex].diff, patch);
});

test("ignores terminal events from earlier work until the turn's prompt is delivered", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-2",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
    promptIds: new Set(["msg_prompt"]),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_1",
    cwd: "/repo",
    disableSubagents: true,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[session.providerThreadId, session]]),
  );
  const event = (type: string, data: OpenCodeRecord = {}) =>
    router.handleEvent({ type, data: { sessionID: "ses_1", ...data } });
  // A compaction from the previous turn finishes after this turn opened.
  await event("session.execution.succeeded");
  assert.equal(session.active, active);
  await event("session.inbox.delivered", { inboxID: "msg_other" });
  await event("session.execution.succeeded");
  assert.equal(session.active, active);
  await event("session.inbox.delivered", { inboxID: "msg_prompt" });
  await event("session.execution.succeeded");
  assert.equal(session.active, undefined);
  assert.equal(emitted.at(-1)?.kind, "turn.boundary");
});

test("shows a Code Mode execute as one code row without nested rows", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_1",
    cwd: "/repo",
    disableSubagents: true,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[session.providerThreadId, session]]),
  );
  const event = (type: string, data: OpenCodeRecord) =>
    router.handleEvent({
      type,
      data: { sessionID: "ses_1", id: "call_exec", ...data },
    });
  // Shapes recorded from OpenCode 2.0.27 with a Code Mode MCP server.
  const code =
    'const a = await tools.cm_echo.shout({text: "hello"});\nreturn a;';
  const call = { tool: "cm_echo.shout", input: { text: "hello" } };
  await event("session.tool.input.started", { name: "execute" });
  await event("session.tool.called", { input: { code } });
  await event("session.tool.progress", {
    metadata: { toolCalls: [{ ...call, status: "running" }] },
  });
  await event("session.tool.success", {
    content: [{ type: "text", text: '"HELLO"' }],
    metadata: { toolCalls: [{ ...call, status: "completed" }] },
  });
  // BB renders any item with a parentRef as a subagent's work.
  assert.equal(emitted.filter((delta) => delta.key?.parentRef).length, 0);
  assert.deepEqual(
    emitted.map((delta) => [delta.kind, delta.key.providerItemId]),
    [
      ["item.open", "call_exec"],
      ["item.close", "call_exec"],
    ],
  );
  assert.equal(emitted[0].presentation.label.completed, "Ran code");
  assert.equal(emitted[0].presentation.title, "cm_echo.shout");
});

test("a failed permission reply never escapes as an unhandled rejection", async () => {
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_1",
    cwd: "/repo",
    permissionMode: "full",
    disableSubagents: true,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let replied = false;
  const router = new OpenCodeEventRouter(
    async () => {
      replied = true;
      throw new Error('OpenCode API 404: {"_tag":"PermissionNotFoundError"}');
    },
    () => {},
    new Map([[session.providerThreadId, session]]),
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await router.handleEvent({
      type: "permission.asked",
      data: { sessionID: "ses_1", id: "per_1", action: "shell" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stderr.write = stderrWrite;
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(replied, true);
  assert.deepEqual(unhandled, []);
});

function routerHarness(providerThreadId: string) {
  const emitted: OpenCodeRecord[] = [];
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId,
    cwd: process.cwd(),
    disableSubagents: false,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active: {
      providerTurnId: "turn-1",
      startedAt: Date.now(),
      abortController: new AbortController(),
      opened: new Map(),
      pendingTools: new Map(),
      pendingInput: new Map(),
      touchedFiles: new Map(),
      openQuestions: new Map(),
      settledTools: new Set(),
    },
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[providerThreadId, session]]),
  );
  const event = (
    type: string,
    data: OpenCodeRecord,
    sessionID = providerThreadId,
  ) => router.handleEvent({ type, data: { sessionID, ...data } });
  const report = (inboxID: string, text: string, metadata: OpenCodeRecord) =>
    event("session.inbox.enqueued", {
      inboxID,
      item: {
        type: "synthetic",
        delivery: "steer",
        payload: { text, metadata },
      },
    });
  return { emitted, session, router, event, report };
}

test("keeps a backgrounded shell as a task and opens a turn when it reports back", async () => {
  const { emitted, session, event, report } = routerHarness("ses_shell");

  await event("session.tool.input.started", { id: "call_sh", name: "shell" });
  await event("session.tool.called", {
    id: "call_sh",
    input: { command: "make test", timeout: 5000 },
  });
  await event("session.tool.success", {
    id: "call_sh",
    content: [
      {
        type: "text",
        text: "Command moved to the background (shell ID: sh_1).\nPID: 42\nOutput is streaming to: /tmp/sh_1.out\n",
      },
    ],
    metadata: { status: "running", shellID: "sh_1", pid: 42 },
  });

  const commandClose = emitted.find(
    (delta) => delta.kind === "item.close" && delta.item.type === "command",
  );
  assert.equal(commandClose?.status, "completed");
  assert.equal(commandClose?.item.exitCode, undefined);
  const taskOpen = emitted.find(
    (delta) =>
      delta.kind === "item.open" && delta.item.type === "backgroundTask",
  );
  assert.deepEqual(taskOpen?.key, { providerItemId: "sh_1" });
  assert.equal(taskOpen?.providerTurnId, "turn-1");
  assert.equal(taskOpen?.item.taskType, "local_bash");
  assert.equal(taskOpen?.item.taskStatus, "running");
  assert.equal(taskOpen?.item.description, "make test");
  assert.equal(taskOpen?.item.outputFile, "/tmp/sh_1.out");

  // The turn ends while the shell keeps running; its row stays open.
  await event("session.execution.succeeded", {});
  assert.equal(session.active, undefined);
  const taskClosed = () =>
    emitted.find(
      (delta) =>
        delta.kind === "item.close" && delta.item.type === "backgroundTask",
    );
  assert.equal(taskClosed(), undefined);

  await report(
    "msg_report",
    '<shell id="sh_1" state="completed" command="make test >&2">\nboom\n\nExit code: 3\n</shell>',
    {
      source: "shell",
      shellID: "sh_1",
      jobID: "sh_1",
      state: "completed",
      exit: 3,
    },
  );
  assert.equal(taskClosed()?.status, "failed");
  assert.equal(taskClosed()?.item.taskStatus, "failed");
  assert.equal(taskClosed()?.item.summary, "boom\n\nExit code: 3");
  assert.equal(taskClosed()?.item.error, "Exited with code 3");
  assert.equal(taskClosed()?.providerTurnId, undefined);

  // The report woke the idle session: OpenCode's reply gets its own turn.
  // Re-read: the assertion above narrowed `active` to undefined.
  const providerTurn = session.active as ActiveTurn | undefined;
  assert.ok(providerTurn);
  assert.equal(providerTurn.checkpointId, "msg_report");
  assert.ok(
    emitted.some(
      (delta) =>
        delta.kind === "turn.open" &&
        delta.providerTurnId === providerTurn.providerTurnId,
    ),
  );
  await event("session.execution.started", {});
  await event("session.inbox.delivered", { inboxID: "msg_report" });
  await event("session.text.started", { assistantMessageID: "m2", ordinal: 0 });
  await event("session.text.ended", {
    assistantMessageID: "m2",
    ordinal: 0,
    text: "The tests failed.",
  });
  await event("session.execution.succeeded", {});
  assert.equal(session.active, undefined);
  const boundary = emitted.at(-1);
  assert.equal(boundary?.kind, "turn.boundary");
  assert.equal(boundary?.providerTurnId, providerTurn.providerTurnId);
  assert.equal(boundary?.providerCheckpointId, "msg_report");
});

test("keeps a background subagent's delegation open until its final report", async () => {
  const { emitted, session, router, event, report } =
    routerHarness("ses_parent");

  await event("session.tool.input.started", {
    id: "call_sub",
    name: "subagent",
  });
  await event("session.tool.called", {
    id: "call_sub",
    input: { agent: "explore", description: "List files", prompt: "ls" },
  });
  await event("session.tool.progress", {
    id: "call_sub",
    metadata: { sessionID: "ses_child", status: "running" },
  });
  await event("session.tool.success", {
    id: "call_sub",
    content: [
      { type: "text", text: "The subagent is working in the background." },
    ],
    metadata: { sessionID: "ses_child", status: "running" },
  });
  const delegationOpen = emitted.find(
    (delta) => delta.kind === "item.open" && delta.item.type === "delegation",
  );
  assert.equal(delegationOpen?.item.background, true);

  router.finish(session, "completed");
  const delegationClosed = () =>
    emitted.find(
      (delta) =>
        delta.kind === "item.close" && delta.item.type === "delegation",
    );
  assert.equal(delegationClosed(), undefined);

  // The child's work after the spawning turn ended is not shown.
  const count = emitted.length;
  await event(
    "session.text.started",
    { assistantMessageID: "child", ordinal: 0 },
    "ses_child",
  );
  assert.equal(emitted.length, count);

  // An idle report with the child's own work outstanding is not final.
  await report(
    "msg_partial",
    '<subagent sessionID="ses_child" state="running">\nStill going.\n</subagent>',
    { source: "subagent", childID: "ses_child", state: "running" },
  );
  assert.equal(delegationClosed(), undefined);
  router.finish(session, "completed");

  await report(
    "msg_final",
    '<subagent sessionID="ses_child" state="completed" description="List files">\na.txt\n</subagent>',
    { source: "subagent", childID: "ses_child", state: "completed" },
  );
  assert.equal(delegationClosed()?.status, "completed");
  assert.equal(delegationClosed()?.item.summary, "a.txt");
  assert.equal(delegationClosed()?.item.childRef, "ses_child");
  assert.deepEqual(delegationClosed()?.key, {
    providerItemId: "call_sub",
    channel: "tool",
  });
});

test("BB settles background rows after their turn and records the wake as a new turn", async () => {
  const { emitted, event, report } = routerHarness("ses_bb");
  emitted.push({ kind: "turn.open", providerTurnId: "turn-1" });

  await event("session.tool.input.started", { id: "call_sh", name: "shell" });
  await event("session.tool.called", {
    id: "call_sh",
    input: { command: "make test" },
  });
  await event("session.tool.success", {
    id: "call_sh",
    content: [{ type: "text", text: "Command moved to the background." }],
    metadata: { status: "running", shellID: "sh_1" },
  });
  await event("session.execution.succeeded", {});
  await report("msg_report", '<shell id="sh_1">ok</shell>', {
    source: "shell",
    shellID: "sh_1",
    state: "completed",
    exit: 0,
  });
  await event("session.inbox.delivered", { inboxID: "msg_report" });
  await event("session.execution.succeeded", {});

  const events = createDeltaAssembler({ providerId: "opencode2" }).assemble({
    threadId: "bb-thread",
    deltas: emitted as never,
  }) as OpenCodeRecord[];
  const types = events.map((entry) => entry.type);
  assert.equal(types.filter((type) => type === "turn/started").length, 2);
  assert.equal(types.filter((type) => type === "turn/completed").length, 2);
  const settled = events.find(
    (entry) => entry.type === "item/backgroundTask/completed",
  );
  assert.equal(settled?.scope.kind, "thread");
  assert.equal(settled?.item.taskStatus, "completed");
  assert.equal(settled?.item.summary, "ok");
  // The task settles after the first turn completed and before the wake.
  assert.ok(types.indexOf("turn/completed") < events.indexOf(settled!));
  assert.ok(events.indexOf(settled!) < types.lastIndexOf("turn/started"));
});

test("opens provider turns only for prompts and reports, and closes withdrawn ones", async () => {
  const { emitted, session, router, event } = routerHarness("ses_idle");
  router.finish(session, "completed");
  const turnOpens = () =>
    emitted.filter((delta) => delta.kind === "turn.open").length;

  await event("session.inbox.enqueued", {
    inboxID: "msg_compact",
    item: { type: "compaction", delivery: "steer", payload: {} },
  });
  assert.equal(session.active, undefined);
  assert.equal(turnOpens(), 0);

  // A prompt from another OpenCode client runs the model, so it gets a turn.
  await event("session.inbox.enqueued", {
    inboxID: "msg_other",
    item: { type: "user", delivery: "queue", payload: { text: "hi" } },
  });
  assert.ok(session.active);
  assert.equal(turnOpens(), 1);

  await event("session.inbox.cancelled", { inboxID: "msg_other" });
  assert.equal(session.active, undefined);
  const boundary = emitted.at(-1);
  assert.equal(boundary?.kind, "turn.boundary");
  assert.equal(boundary?.status, "interrupted");
  assert.equal(boundary?.providerCheckpointId, undefined);
});
