import { join } from "node:path";
import type { ModelSettings } from "../settings-contract.ts";
import {
  BRIDGE_JSON_RPC_ERRORS,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  ProviderRequestDecodeError,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  THREAD_DELTA_GRAMMAR_V3,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  emit,
  handleRuntimeResponse,
  nextBridgeSequence,
  notify,
  rejectPendingRuntimeRequests,
  sendError,
  sendResult,
} from "./bridge-runtime.ts";
import {
  DYNAMIC_TOOLS_MCP_ARG,
  runDynamicToolsMcpStdioChild,
} from "./dynamic-tools-mcp.ts";
import {
  assertModelEnabled,
  agentSessionOption,
  mapModel,
  modelRefFromOptions,
  sameModelRef,
} from "./models.ts";
import {
  dynamicMcpRemovalRequest,
  sessionRenameRequest,
  steerAcceptedDelta,
} from "./opencode-requests.ts";
import {
  installationRun,
  installationStatus,
  providerHealth,
} from "./maintenance.ts";
import { openCodeServer } from "./opencode-server.ts";
import { promptBody } from "./prompt.ts";
import {
  ensureSessionModel,
  prepareTurn,
  publishAgentOption,
  registerSession,
  releaseDynamicTools,
  sessionFromParams,
  shutdownSessions,
  unregisterSession,
} from "./session-manager.ts";
import {
  isManualCompactionTurn,
  manualCompactionRequest,
  manualCompactionStartDeltas,
} from "./timeline.ts";
import {
  errorMessage,
  inputRecord,
  sessions,
  sessionsByProviderId,
  stringValue,
  type ActiveTurn,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

let configuredSkillFiles: Map<string, string> | undefined;
let configuredSkillNames: Set<string> | undefined;

const PARAM_SCHEMAS = {
  initialize: initializeParamsSchema,
  "model/list": modelListParamsSchema,
  "provider/health": providerMaintenanceParamsSchema,
  "provider/installation/status": providerInstallationStatusParamsSchema,
  "provider/installation/run": providerInstallationRunParamsSchema,
  "thread/start": threadStartParamsSchema,
  "thread/resume": threadResumeParamsSchema,
  "thread/fork": threadForkParamsSchema,
  "thread/stop": threadStopParamsSchema,
  "thread/discard": threadDiscardParamsSchema,
  "thread/name/set": threadNameSetParamsSchema,
  "turn/start": turnStartParamsSchema,
  "turn/steer": turnSteerParamsSchema,
  "skills/configure": skillsConfigureParamsSchema,
} as const;

function providerSessionId(response: RecordValue): string {
  const id = stringValue(response.data?.id);
  if (!id) throw new Error("OpenCode did not return a session ID");
  return id;
}

async function configureSession(
  params: RecordValue,
  providerThreadId: string,
  modelSettings: ModelSettings,
  forceModel: boolean,
): Promise<SessionState> {
  const session = sessionFromParams(params, providerThreadId, modelSettings);
  try {
    session.nativeSkillNames = await openCodeServer.nativeSkillNames(
      params.cwd,
    );
    await registerSession(session);
    if (forceModel) {
      await ensureSessionModel(session, session.model, true);
    }
    return session;
  } catch (error) {
    await unregisterSession(session, "OpenCode session setup failed");
    throw error;
  }
}

function parseProviderParams(method: string, params: unknown): RecordValue {
  const schema = PARAM_SCHEMAS[method as keyof typeof PARAM_SCHEMAS];
  if (!schema) return inputRecord(params);
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ProviderRequestDecodeError(
      `Invalid ${method} params: ${path}${issue?.message ?? "validation failed"}`,
    );
  }
  return parsed.data as RecordValue;
}

async function handle(request: RecordValue) {
  const params = parseProviderParams(String(request.method), request.params);
  switch (request.method) {
    case "initialize":
      sendResult(request.id, {
        ok: true,
        protocolVersion: 2,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: true,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "queue",
          skills: { configure: true },
        },
      });
      return;
    case "provider/health": {
      const settings = await openCodeServer.readModelSettings();
      sendResult(request.id, {
        supported: true,
        health: await providerHealth(settings, params.cwd ?? process.cwd()),
      });
      return;
    }
    case "provider/installation/status":
      sendResult(
        request.id,
        await installationStatus(params.checkUpdates !== false),
      );
      return;
    case "provider/installation/run":
      sendResult(request.id, await installationRun(params.action));
      return;
    case "model/list": {
      const cwd = params.cwd ?? process.cwd();
      const settings = await openCodeServer.readModelSettings();
      if (!settings.providerEnabled || settings.enabledModels?.length === 0) {
        sendResult(request.id, { models: [], selectedOnlyModels: [] });
        return;
      }
      const catalog = await openCodeServer.modelCatalog(cwd, true);
      const models = catalog.models
        .filter(
          (model) =>
            settings.enabledModels === null ||
            settings.enabledModels.includes(`${model.providerID}/${model.id}`),
        )
        .sort((left, right) =>
          `${left.providerID}/${left.id}`.localeCompare(
            `${right.providerID}/${right.id}`,
          ),
        );
      // Mark OpenCode's own default; fall back to the first listed model when
      // the default is unknown or blocked by the allowlist.
      const defaultId = models.some(
        (model) => `${model.providerID}/${model.id}` === catalog.defaultId,
      )
        ? catalog.defaultId
        : models[0] && `${models[0].providerID}/${models[0].id}`;
      // Agents come from this workspace, so project-level agents show up.
      const agentOption = agentSessionOption(
        await openCodeServer.primaryAgents(cwd).catch(() => []),
      );
      sendResult(request.id, {
        models: models.map((model) =>
          mapModel(
            model,
            `${model.providerID}/${model.id}` === defaultId,
            agentOption ? [agentOption] : [],
          ),
        ),
        selectedOnlyModels: [],
      });
      return;
    }
    case "thread/start": {
      const modelSettings = await openCodeServer.readModelSettings(
        params.options?.providerOptions,
      );
      if (!modelSettings.providerEnabled) {
        throw new Error("OpenCode provider is disabled");
      }
      const selected = modelRefFromOptions(params.options);
      assertModelEnabled(
        selected,
        modelSettings.enabledModels === null
          ? null
          : new Set(modelSettings.enabledModels),
      );
      const body: RecordValue = { location: { directory: params.cwd } };
      if (selected) body.model = selected;
      const result = await openCodeServer.request("/api/session", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const providerThreadId = providerSessionId(result);
      try {
        await configureSession(params, providerThreadId, modelSettings, false);
      } catch (error) {
        await openCodeServer
          .request(`/api/session/${encodeURIComponent(providerThreadId)}`, {
            method: "DELETE",
          })
          .catch(() => {});
        throw error;
      }
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId,
        sessionRestorable: true,
      });
      emit(params.threadId, [{ kind: "session.reset" }]);
      sendResult(request.id, { providerThreadId, sessionRestorable: true });
      const started = sessions.get(String(params.threadId));
      if (started) void publishAgentOption(started);
      return;
    }
    case "thread/resume": {
      await openCodeServer.start();
      const modelSettings = await openCodeServer.readModelSettings(
        params.options?.providerOptions,
      );
      await configureSession(
        params,
        params.providerThreadId,
        modelSettings,
        true,
      );
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId: params.providerThreadId,
        sessionRestorable: true,
      });
      emit(params.threadId, [{ kind: "session.reset" }]);
      sendResult(request.id, {
        providerThreadId: params.providerThreadId,
        sessionRestorable: true,
      });
      const resumed = sessions.get(String(params.threadId));
      if (resumed) void publishAgentOption(resumed);
      return;
    }
    case "thread/fork": {
      const existing = sessions.get(params.threadId);
      const checkpointId = stringValue(params.sourceProviderCheckpointId);
      // BB reuses the same BB thread ID when rewinding (or editing a past
      // message and resending): truncate the OpenCode session in place via
      // revert so files are restored and the session ID is preserved. A fork
      // for a *new* BB thread copies history into a child session instead.
      const sameThreadRewind =
        !!existing &&
        existing.providerThreadId === params.sourceProviderThreadId &&
        !!checkpointId;
      let statelessRewindUsage: SessionState["usage"] | undefined;
      let statelessRewind = false;
      if (!sameThreadRewind && !existing && checkpointId) {
        // No live session: this worker restarted, or another worker owns the
        // thread. A persisted same-thread mapping still identifies an
        // in-place rewind. Without one (a genuinely new BB thread, or a
        // source session held under another BB thread) fall through to fork
        // so a copy is made instead of truncating history that isn't ours.
        const sourceInMemory = sessionsByProviderId.get(
          params.sourceProviderThreadId,
        );
        if (!sourceInMemory) {
          const persisted = await openCodeServer
            .lookupSessionRegistration(params.threadId)
            .catch(() => undefined);
          if (
            persisted &&
            persisted.providerThreadId === params.sourceProviderThreadId
          ) {
            statelessRewind = true;
            statelessRewindUsage = { ...persisted.usage };
          }
        }
      }
      if ((sameThreadRewind || statelessRewind) && checkpointId) {
        if (existing?.active) {
          await openCodeServer
            .request(
              `/api/session/${encodeURIComponent(existing.providerThreadId)}/interrupt`,
              { method: "POST" },
            )
            .catch(() => {});
          openCodeServer.finish(existing, "interrupted");
        }
        await openCodeServer.rewindSessionRetainingThrough(
          params.sourceProviderThreadId,
          checkpointId,
        );
        const modelSettings = await openCodeServer.readModelSettings(
          params.options?.providerOptions,
        );
        const rewound = sessionFromParams(
          params,
          params.sourceProviderThreadId,
          modelSettings,
        );
        rewound.usage =
          existing?.usage ?? statelessRewindUsage ?? rewound.usage;
        try {
          rewound.nativeSkillNames = await openCodeServer.nativeSkillNames(
            params.cwd,
          );
          await registerSession(rewound);
          if (existing) {
            if (rewound.model && !sameModelRef(existing.model, rewound.model)) {
              await ensureSessionModel(rewound, rewound.model, true);
            } else {
              rewound.model = existing.model ?? rewound.model;
            }
          } else if (rewound.model) {
            // Stateless rewind (no live session to compare against): converge
            // on BB's current selection like thread/resume does.
            await ensureSessionModel(rewound, rewound.model, true);
          }
        } catch (error) {
          await unregisterSession(rewound, "OpenCode rewind setup failed");
          throw error;
        }
        notify("thread/identity", {
          threadId: params.threadId,
          providerThreadId: params.sourceProviderThreadId,
          sessionRestorable: true,
        });
        sendResult(request.id, {
          providerThreadId: params.sourceProviderThreadId,
          sessionRestorable: true,
        });
        return;
      }
      const boundary = await openCodeServer.forkBoundaryRetainingThrough(
        params.sourceProviderThreadId,
        checkpointId,
      );
      const result = await openCodeServer.request(
        `/api/session/${encodeURIComponent(params.sourceProviderThreadId)}/fork`,
        { method: "POST", body: JSON.stringify(boundary) },
      );
      const providerThreadId = providerSessionId(result);
      const modelSettings = await openCodeServer.readModelSettings(
        params.options?.providerOptions,
      );
      try {
        await configureSession(params, providerThreadId, modelSettings, true);
      } catch (error) {
        await openCodeServer
          .request(`/api/session/${encodeURIComponent(providerThreadId)}`, {
            method: "DELETE",
          })
          .catch(() => {});
        throw error;
      }
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId,
        sessionRestorable: true,
      });
      emit(params.threadId, [{ kind: "session.reset" }]);
      sendResult(request.id, { providerThreadId, sessionRestorable: true });
      return;
    }
    case "thread/name/set":
      {
        const rename = sessionRenameRequest(
          params.providerThreadId,
          params.title,
        );
        await openCodeServer.request(rename.path, rename.init);
      }
      sendResult(request.id, { ok: true });
      return;
    case "turn/start": {
      const session = sessions.get(params.threadId);
      if (!session) throw new Error("No active OpenCode session");
      if (session.active) throw new Error("An OpenCode turn is already active");
      const active: ActiveTurn = {
        providerTurnId: `turn_${Date.now()}_${nextBridgeSequence()}`,
        startedAt: Date.now(),
        abortController: new AbortController(),
        opened: new Map<string, RecordValue>(),
        pendingTools: new Map<string, string>(),
        pendingInput: new Map<string, string>(),
        touchedFiles: new Map<string, string[]>(),
        openQuestions: new Map<string, string>(),
        settledTools: new Set<string>(),
      };
      session.active = active;
      if (isManualCompactionTurn(params.input)) {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        active.manualCompaction = { itemId: messageId };
        active.opened.set(messageId, { type: "compaction" });
        emit(
          session.bbThreadId,
          manualCompactionStartDeltas(
            params.clientRequestId,
            active.providerTurnId,
            messageId,
          ),
        );
        sendResult(request.id, { threadId: params.threadId });
        const compact = manualCompactionRequest(
          session.providerThreadId,
          messageId,
        );
        void openCodeServer
          .request(compact.path, {
            method: "POST",
            body: JSON.stringify(compact.body),
          })
          .catch((error) => {
            if (session.active === active)
              openCodeServer.finish(session, "failed", errorMessage(error));
          });
        return;
      }
      emit(session.bbThreadId, [
        // Order matters: BB records turn/input/accepted only against an
        // already-started turn. Emitting input.accepted first (both carry the
        // same providerTurnId) makes the assembler scope the accepted event to
        // a turn BB hasn't started yet, so it is dropped, the turn keeps zero
        // accepted inputs, and BB hides Edit message / rejects edit-message
        // with "not accepted into exactly one turn".
        { kind: "turn.open", providerTurnId: active.providerTurnId },
        {
          kind: "input.accepted",
          clientRequestId: params.clientRequestId,
          providerTurnId: active.providerTurnId,
        },
      ]);
      sendResult(request.id, { threadId: params.threadId });
      // The beta prompt schema does not accept per-prompt `system` or `tools`.
      // BB instructions use the session entry installed above; `disallowedTools`
      // is enforced while building the BB dynamic MCP catalog, while native
      // OpenCode tool filtering has no supported beta API surface.
      // OpenCode reasoning effort is a model variant, and the prompt endpoint
      // accepts no model: switch the session model first so the effort picker
      // reaches OpenCode, then prompt.
      // Track the user message ID optimistically so turn.boundary always
      // carries a providerCheckpointId for rewind/edit, even if the prompt
      // response is slow. The response ID should match; keep the latest.
      const promptId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      active.checkpointId = promptId;
      active.promptIds = new Set([promptId]);
      const promptPayload = {
        id: promptId,
        ...promptBody(params.input, {
          configuredSkillNames,
          disableSubagents: session.disableSubagents,
          nativeSkillNames: session.nativeSkillNames,
          skillFiles: configuredSkillFiles,
        }),
        delivery: "steer",
      };
      void (async () => {
        try {
          await prepareTurn(session, params.options);
          const result = await openCodeServer.request(
            `/api/session/${encodeURIComponent(session.providerThreadId)}/prompt`,
            { method: "POST", body: JSON.stringify(promptPayload) },
          );
          const id = stringValue(result?.data?.id);
          if (id && session.active === active) {
            active.checkpointId = id;
            active.promptIds?.add(id);
          }
          active.promptDelivered = true;
        } catch (error) {
          if (session.active === active) {
            // The optimistic prompt ID was never created in OpenCode, so it
            // must not leak into a failed turn boundary as a checkpoint.
            // Otherwise a later edit/rewind would fail with "checkpoint not
            // found" for an ID OpenCode never stored.
            active.checkpointId = undefined;
            openCodeServer.finish(session, "failed", errorMessage(error));
          }
        }
      })();
      return;
    }
    case "turn/steer": {
      const session = sessions.get(params.threadId);
      if (!session) throw new Error("No active OpenCode session");
      const clientRequestId = stringValue(params.clientRequestId);
      if (!clientRequestId)
        throw new Error("Missing clientRequestId for steered input");
      // With steerMode "queue" BB keeps the follow-up row as "Steer pending"
      // until the bridge confirms acceptance, so always close the loop with
      // input.accepted (mirrors turn/start and the Codex bridge).
      let active = session.active;
      const openedTurn = !active;
      if (!active) {
        active = {
          providerTurnId: `turn_${Date.now()}_${nextBridgeSequence()}`,
          startedAt: Date.now(),
          abortController: new AbortController(),
          opened: new Map<string, RecordValue>(),
          pendingTools: new Map<string, string>(),
          pendingInput: new Map<string, string>(),
          touchedFiles: new Map<string, string[]>(),
          openQuestions: new Map<string, string>(),
          settledTools: new Set<string>(),
        };
        session.active = active;
        emit(session.bbThreadId, [
          { kind: "turn.open", providerTurnId: active.providerTurnId },
        ]);
      }
      try {
        await prepareTurn(session, params.options);
        const promptId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        // Register before sending: OpenCode may report delivery first.
        (active.promptIds ??= new Set()).add(promptId);
        const result = await openCodeServer.request(
          `/api/session/${encodeURIComponent(session.providerThreadId)}/prompt`,
          {
            method: "POST",
            body: JSON.stringify({
              id: promptId,
              ...promptBody(params.input, {
                configuredSkillNames,
                disableSubagents: session.disableSubagents,
                nativeSkillNames: session.nativeSkillNames,
                skillFiles: configuredSkillFiles,
              }),
              delivery: "steer",
            }),
          },
        );
        if (session.active !== active) {
          throw new Error(
            "OpenCode turn ended before steered input was accepted",
          );
        }
        const id = stringValue(result?.data?.id) ?? promptId;
        active.checkpointId = id;
        active.promptIds.add(id);
        active.promptDelivered = true;
        emit(session.bbThreadId, [
          steerAcceptedDelta(clientRequestId, active.providerTurnId),
        ]);
        sendResult(request.id, { threadId: params.threadId });
        return;
      } catch (error) {
        if (openedTurn && session.active === active) {
          openCodeServer.finish(session, "failed", errorMessage(error));
        }
        throw error;
      }
    }
    case "thread/stop": {
      const session = sessions.get(params.threadId);
      if (session) {
        await openCodeServer
          .request(
            `/api/session/${encodeURIComponent(session.providerThreadId)}/interrupt`,
            { method: "POST" },
          )
          .catch(() => {});
        openCodeServer.finish(session, "interrupted");
      }
      sendResult(request.id, { ok: true });
      return;
    }
    case "thread/discard": {
      const session = sessions.get(params.threadId);
      if (session) {
        await openCodeServer
          .request(
            `/api/session/${encodeURIComponent(session.providerThreadId)}`,
            { method: "DELETE" },
          )
          .catch(() => {});
        await releaseDynamicTools(session, "The BB thread was discarded");
      } else if (
        typeof params.providerThreadId === "string" &&
        params.providerThreadId
      ) {
        // No local session (another host worker owns the thread, or this
        // worker restarted since setup): still remove the per-session MCP
        // bridge so OpenCode does not keep a dead server entry behind.
        const orphan = await openCodeServer.lookupMcpRegistration(
          params.providerThreadId,
        );
        if (orphan) {
          const removal = dynamicMcpRemovalRequest(
            orphan.serverName,
            orphan.cwd,
          );
          try {
            await openCodeServer.request(removal.path, removal.init);
            await openCodeServer.forgetMcpRegistration(params.providerThreadId);
          } catch {
            // Keep the registry entry so a later discard can retry.
          }
        }
        await openCodeServer
          .request(
            `/api/session/${encodeURIComponent(params.providerThreadId)}`,
            { method: "DELETE" },
          )
          .catch(() => {});
      }
      sessions.delete(params.threadId);
      if (session) sessionsByProviderId.delete(session.providerThreadId);
      else if (typeof params.providerThreadId === "string")
        sessionsByProviderId.delete(params.providerThreadId);
      // Drop the persisted mapping so a later thread/fork for this BB thread
      // ID cannot mistake a new session for an in-place rewind target.
      await openCodeServer
        .forgetSessionRegistration(params.threadId)
        .catch(() => {});
      sendResult(request.id, { ok: true });
      return;
    }
    case "skills/configure": {
      const configured = skillsConfigureParamsSchema.parse(params);
      configuredSkillNames = new Set(
        configured.roots.flatMap((root) =>
          root.skills.map((skill) => skill.name),
        ),
      );
      configuredSkillFiles = new Map(
        configured.roots.flatMap((root) =>
          root.skills.map(
            (skill) =>
              [skill.name, join(root.path, skill.name, "SKILL.md")] as const,
          ),
        ),
      );
      sendResult(request.id, { ok: true });
      return;
    }
    default:
      sendError(
        request.id,
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method "${request.method}"`,
      );
  }
}

function handleParsedMessage(raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const input = raw as RecordValue;
  if (handleRuntimeResponse(input)) return;
  if (
    input.id === undefined ||
    input.jsonrpc !== "2.0" ||
    typeof input.method !== "string"
  )
    return;
  runBridgeRequest({
    request: input as { id: string | number; method: string; params?: object },
    handleRequest: handle,
    sendError,
  });
}

const handleLine = createBridgeLineHandler({ handleParsedMessage });

// OpenCode launches this same bundled host artifact as the per-thread MCP
// child. The provider bridge export remains inert in that process.
if (process.argv.includes(DYNAMIC_TOOLS_MCP_ARG)) {
  runDynamicToolsMcpStdioChild();
}

let shutdownPromise: Promise<void> | undefined;

export function shutdownBridge(
  reason = "OpenCode bridge stopped",
): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      rejectPendingRuntimeRequests(reason);
      await shutdownSessions(reason).catch(() => {});
      await openCodeServer.stop();
    })();
  }
  return shutdownPromise;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: ({ dataDir }) => {
    openCodeServer.setDataDir(dataDir);
  },
  onClose: () => {
    void shutdownBridge("BB runtime disconnected");
  },
  onSigterm: () => {
    void shutdownBridge();
  },
  onSigint: () => {
    void shutdownBridge();
  },
});
